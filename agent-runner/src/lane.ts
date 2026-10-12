// SPDX-License-Identifier: Apache-2.0
// Adapted from cloudflare/sandbox-sdk examples/coding-agents/runner/sandbox.ts (Apache-2.0).
// One Durable Object + Container per Heddle lane: clone the lane's Artifacts fork, run one coding
// agent on the task brief in the background, and report its outcome. The agent commits and
// pushes to its fork itself; the control plane sees that push like any other.
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";

import type { Outbound } from "./outbound";
import type { LaneGrant } from "./policy";

const REPOSITORY_DIRECTORY = "/workspace/repo";
const TASK_DIRECTORY = "/workspace/task";
const EVENTS_PATH = `${TASK_DIRECTORY}/events.jsonl`;
const STDERR_PATH = `${TASK_DIRECTORY}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIRECTORY}/exit-code`;
const PID_PATH = `${TASK_DIRECTORY}/pid`;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
// Requests keep a Container awake; a running process does not. Check the task well within the timeout.
const TASK_CHECK_INTERVAL_MS = 60 * 1_000;
const TASK_KEY = "task";
const GRANT_KEY = "grant";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// exec() does not inherit start() env. Pass these on every command that makes HTTPS requests.
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  npm_config_cafile: CA_PATH,
  GIT_TERMINAL_PROMPT: "0",
};

// Output goes to files so the agent keeps running after the request that started it ends.
const TASK_SCRIPT = `"$@" >${EVENTS_PATH} 2>${STDERR_PATH}
printf '%s\\n' "$?" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}`;

export interface RunnerEnv {
  CODEX: DurableObjectNamespace<LaneSandbox>;
  CLAUDE: DurableObjectNamespace<LaneSandbox>;
  OPENCODE: DurableObjectNamespace<LaneSandbox>;
  RUNNER_TOKEN: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_METADATA?: string;
  ARTIFACTS_HOST: string;
  ARTIFACTS_NAMESPACE: string;
  CODEX_MODEL: string;
  CLAUDE_MODEL: string;
  OPENCODE_MODEL: string;
}

interface LaneState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly Outbound: LoopbackForExport<typeof Outbound> };
}

export interface AgentCommand { argv: string[]; env: Record<string, string> }
export type TaskOutcome = { state: "succeeded"; result: string } | { state: "failed"; error: string };
export type TaskStatus = { state: "none" } | { state: "running" } | { state: "lost" } | TaskOutcome;
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface LaneStart { grant: LaneGrant; prompt: string; author: { name: string; email: string }; model?: string }

export abstract class LaneSandbox extends DurableObject<RunnerEnv> {
  protected abstract readonly agent: string;
  protected readonly taskDirectory = TASK_DIRECTORY;
  readonly #container: Container;
  readonly #files: Files;

  constructor(ctx: LaneState, env: RunnerEnv) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    // Each Durable Object instance sets its own timeout and intercepts; neither is inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await this.#intercept();
        await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      });
    }
  }

  protected abstract command(prompt: string, model?: string): AgentCommand;
  protected abstract outcome(exitCode: number): Promise<TaskOutcome>;

  /** Clone the fork, wire the read-only upstream, then start the agent. One lane runs once. */
  start(name: string, lane: LaneStart): Promise<"started" | "busy" | { failed: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.storage.kv.get(TASK_KEY) !== undefined) return "busy";
      this.ctx.storage.kv.put(GRANT_KEY, lane.grant);
      await this.#ensureExecution(name);
      const steps: string[][] = [
        // A retried start may find a partial clone from a container that started cold and failed.
        ["rm", "-rf", REPOSITORY_DIRECTORY],
        ["git", "clone", "--quiet", "--", lane.grant.forkRemote, REPOSITORY_DIRECTORY],
        ["git", "-C", REPOSITORY_DIRECTORY, "remote", "add", "upstream", lane.grant.upstreamRemote],
        ["git", "-C", REPOSITORY_DIRECTORY, "config", "user.name", lane.author.name],
        ["git", "-C", REPOSITORY_DIRECTORY, "config", "user.email", lane.author.email],
      ];
      for (const argv of steps) {
        const result = await this.#run(argv, "/workspace", TRUST_ENV);
        if (result.exitCode !== 0) return { failed: `${argv.slice(0, 3).join(" ")} exited ${result.exitCode}: ${result.stderr.slice(-500)}` };
      }
      await this.#files.remove(TASK_DIRECTORY, { recursive: true, force: true });
      await this.#files.mkdir(TASK_DIRECTORY);
      const { argv, env } = this.command(lane.prompt, lane.model);
      const task = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...argv], {
        cwd: REPOSITORY_DIRECTORY, env: { ...TRUST_ENV, ...env }, stdout: "ignore", stderr: "ignore",
      });
      await this.#files.writeFile(PID_PATH, String(task.pid));
      this.ctx.storage.kv.put(TASK_KEY, "started");
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return "started";
    });
  }

  // Each check is a request to the Container, so it stays awake while the agent runs.
  async alarm(): Promise<void> {
    if (!this.#container.running) return;
    if ((await this.#taskStatus()).state === "running") {
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return;
    }
    // Finished: the grant is no longer needed by this lane.
    this.ctx.storage.kv.delete(GRANT_KEY);
  }

  async status(): Promise<TaskStatus> {
    if (!this.#container.running) return this.ctx.storage.kv.get(TASK_KEY) === undefined ? { state: "none" } : { state: "lost" };
    return this.#taskStatus();
  }

  /** The last bytes of the agent's event stream, for an operator watching the lane. */
  async tail(maxBytes: number): Promise<string> {
    const text = (await this.#readOptionalText(EVENTS_PATH)) ?? "";
    return text.slice(-maxBytes);
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete(TASK_KEY);
    this.ctx.storage.kv.delete(GRANT_KEY);
    if (this.#container.running) await this.#container.destroy();
  }

  protected async *events<Event>(schema: z.ZodType<Event>): AsyncGenerator<Event> {
    for await (const line of readLines((await this.#files.readFile(EVENTS_PATH)).body)) {
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      const parsed = schema.safeParse(event);
      if (parsed.success) yield parsed.data;
    }
  }

  protected readTaskFile(path: string): Promise<string | undefined> { return this.#readOptionalText(path); }

  protected async exitFailure(exitCode: number): Promise<TaskOutcome> {
    const stderr = (await this.#readOptionalText(STDERR_PATH)) ?? "";
    return { state: "failed", error: `${this.agent} exited with ${exitCode}: ${stderr.slice(-2_000)}` };
  }

  async #intercept(): Promise<void> {
    const grant = this.ctx.storage.kv.get<LaneGrant>(GRANT_KEY);
    const outbound = (this.ctx as LaneState).exports.Outbound({ props: { grant } });
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
  }

  async #ensureExecution(name: string): Promise<void> {
    if (!this.#container.running) {
      // A new Container has a fresh disk, so any earlier task is gone.
      this.ctx.storage.kv.delete(TASK_KEY);
      this.#container.start({
        image: this.#container.images.sandbox,
        instance: "standard-1",
        // No direct Internet: every request goes through Outbound, which allows only the gateway and Workers AI,
        // this lane's Artifacts repositories and the read-only npm registry.
        enableInternet: false,
        labels: { app: "heddle-agent-runner", agent: this.agent, lane: name },
      });
    }
    await this.#intercept();
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async #taskStatus(): Promise<TaskStatus> {
    const exitCode = await this.#readOptionalText(EXIT_CODE_PATH);
    if (exitCode !== undefined) return this.outcome(Number.parseInt(exitCode, 10));
    const pid = await this.#readOptionalText(PID_PATH);
    if (pid === undefined) return { state: "none" };
    const probe = await this.#run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid.trim()], "/", {});
    if (probe.exitCode === 0) return { state: "running" };
    const lateExitCode = await this.#readOptionalText(EXIT_CODE_PATH);
    if (lateExitCode !== undefined) return this.outcome(Number.parseInt(lateExitCode, 10));
    return { state: "lost" };
  }

  async #readOptionalText(path: string): Promise<string | undefined> {
    try { return await (await this.#files.readFile(path)).text(); }
    catch (cause) { if (SandboxFileError.is(cause) && cause.code === "ENOENT") return undefined; throw cause; }
  }

  async #run(command: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
    const process = await this.#container.exec(command, { cwd, env });
    const output = await process.output();
    const decoder = new TextDecoder();
    return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  }
}

async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    yield* lines;
  }
  buffered += decoder.decode();
  if (buffered !== "") yield buffered;
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}
