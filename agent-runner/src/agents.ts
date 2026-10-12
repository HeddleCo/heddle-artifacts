// SPDX-License-Identifier: Apache-2.0
// Agent adapters adapted from cloudflare/sandbox-sdk examples/coding-agents/{codex,claude-code} (Apache-2.0).
import { z } from "zod";

import { type AgentCommand, LaneSandbox, type TaskOutcome } from "./lane";
import { GATEWAY_HOST, workersAiBase } from "./policy";

const codexFailure = z.union([
  z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export class CodexLane extends LaneSandbox {
  protected readonly agent = "codex";
  get #lastMessagePath(): string { return `${this.taskDirectory}/last-message.txt`; }

  protected command(prompt: string): AgentCommand {
    // Workers AI models (for example @cf/openai/gpt-oss-120b) through Cloudflare's Responses-compatible API.
    const baseUrl = workersAiBase(this.env.AI_GATEWAY_ACCOUNT_ID);
    return {
      argv: [
        "codex", "exec", "--json", "--ephemeral",
        // The Container is the sandbox, so Codex runs commands without its own.
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message", this.#lastMessagePath,
        "--model", this.env.CODEX_MODEL,
        // A custom provider sends no API key; the Worker adds the gateway token.
        "--config", 'model_provider="workers-ai"',
        "--config", `model_providers.workers-ai={ name = "Cloudflare Workers AI", base_url = ${JSON.stringify(baseUrl)}, wire_api = "responses" }`,
        "--config", "analytics.enabled=false",
        "--config", "check_for_update_on_startup=false",
        "--config", "features.plugins=false",
        "--", prompt,
      ],
      env: {},
    };
  }

  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    if (exitCode === 0) return { state: "succeeded", result: (await this.readTaskFile(this.#lastMessagePath)) ?? "" };
    let failure: string | undefined;
    for await (const event of this.events(codexFailure)) failure = event.type === "error" ? event.message : event.error.message;
    return failure === undefined ? this.exitFailure(exitCode) : { state: "failed", error: failure };
  }
}

const claudeResult = z.object({ type: z.literal("result"), subtype: z.string(), is_error: z.boolean(), result: z.string().optional() });

export class ClaudeLane extends LaneSandbox {
  protected readonly agent = "claude";

  protected command(prompt: string): AgentCommand {
    return {
      argv: [
        "claude", "--print", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions", "--no-session-persistence",
        "--model", this.env.CLAUDE_MODEL, "--", prompt,
      ],
      env: {
        ANTHROPIC_BASE_URL: `https://${GATEWAY_HOST}/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/anthropic`,
        // Claude Code requires a key; the Worker drops it and adds the gateway token.
        ANTHROPIC_API_KEY: "provided-by-worker",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // The Container runs as root, where skipping permissions requires this.
        IS_SANDBOX: "1",
      },
    };
  }

  // A failed model call still reports subtype "success", so read is_error.
  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    let result: z.infer<typeof claudeResult> | undefined;
    for await (const event of this.events(claudeResult)) result = event;
    if (result === undefined) return this.exitFailure(exitCode);
    return result.is_error ? { state: "failed", error: result.result ?? result.subtype } : { state: "succeeded", result: result.result ?? "" };
  }
}

const opencodeEvent = z.union([
  z.object({ type: z.literal("text"), part: z.object({ text: z.string() }) }),
  z.object({ type: z.literal("error"), error: z.object({ name: z.string(), data: z.object({ message: z.string().optional() }).optional() }) }),
]);

// OpenCode on a Workers AI coding model (for example @cf/moonshotai/kimi-k2.7-code), adapted from
// cloudflare/sandbox-sdk examples/coding-agents/opencode (Apache-2.0).
export class OpencodeLane extends LaneSandbox {
  protected readonly agent = "opencode";

  protected command(prompt: string, model?: string): AgentCommand {
    return {
      argv: ["opencode", "run", "--format", "json", "--auto", "--model", model ?? this.env.OPENCODE_MODEL, "--", prompt],
      env: {
        // OpenCode requires a key; the Worker replaces this placeholder on each request.
        CLOUDFLARE_API_KEY: "provided-by-worker",
        CLOUDFLARE_ACCOUNT_ID: this.env.AI_GATEWAY_ACCOUNT_ID,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_SHARE: "1",
      },
    };
  }

  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    let text = "", error: string | undefined;
    for await (const event of this.events(opencodeEvent)) {
      if (event.type === "text") text = event.part.text;
      else error = event.error.data?.message ?? event.error.name;
    }
    if (exitCode === 0) return { state: "succeeded", result: text };
    return error === undefined ? this.exitFailure(exitCode) : { state: "failed", error };
  }
}
