// SPDX-License-Identifier: Apache-2.0
// Adapted from cloudflare/sandbox-sdk examples/coding-agents/runner/sandbox.ts (Apache-2.0).
// One Durable Object + Container per Heddle lane: clone the lane's Artifacts fork, run one coding
// agent on the task brief in the background, and report its outcome. The agent commits and
// pushes to its fork itself; the control plane sees that push like any other.
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";

import type { Outbound } from "./outbound";
import type { DiscussionTarget, LaneGrant } from "./policy";
import { cleanAnnouncement } from "./announce";
import { AHEAD_ARGV, FOLLOW_UP_PROMPT, STATUS_ARGV, hasUnpushedWork } from "./follow-up";

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
const DISCUSSION_KEY = "discussion";
const ANNOUNCED_KEY = "announced";
const MODEL_KEY = "model";
// "checked" once the finished run was examined; "started" while its one follow-up turn runs.
const FOLLOW_UP_KEY = "follow-up";
const FIRST_RESULT_KEY = "first-result";
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
  CONTROL_PLANE_HOST: string;
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
export interface LaneStart { grant: LaneGrant; prompt: string; author: { name: string; email: string }; model?: string; discussion?: DiscussionTarget }

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
  /** The same agent, continuing its last session with a new prompt; undefined when it cannot. */
  protected continueCommand(_prompt: string, _model?: string): AgentCommand | undefined { return undefined; }
  protected abstract outcome(exitCode: number): Promise<TaskOutcome>;

  /** Clone the fork, wire the read-only upstream, then start the agent. One lane runs once. */
  start(name: string, lane: LaneStart): Promise<"started" | "busy" | { failed: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.storage.kv.get(TASK_KEY) !== undefined) return "busy";
      this.ctx.storage.kv.put(GRANT_KEY, lane.grant);
      if (lane.model) this.ctx.storage.kv.put(MODEL_KEY, lane.model);
      if (lane.discussion) this.ctx.storage.kv.put(DISCUSSION_KEY, lane.discussion);
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
    const status = await this.#taskStatus();
    if (status.state === "running") {
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return;
    }
    await this.#announce(status);
    // Finished: the grant is no longer needed by this lane.
    this.ctx.storage.kv.delete(GRANT_KEY);
  }

  async status(): Promise<TaskStatus> {
    if (!this.#container.running) return this.ctx.storage.kv.get(TASK_KEY) === undefined ? { state: "none" } : { state: "lost" };
    const status = await this.#taskStatus();
    await this.#announce(status);
    return status;
  }

  /**
   * Post the agent's closing message to its task discussion as a signed turn, once. This runs in
   * the Worker with the agent's own key; the sandbox never sees the key or reaches the control plane.
   */
  async #announce(status: TaskStatus): Promise<void> {
    const target = this.ctx.storage.kv.get<DiscussionTarget>(DISCUSSION_KEY);
    if (status.state !== "succeeded" || !target || this.ctx.storage.kv.get(ANNOUNCED_KEY)) return;
    const body = cleanAnnouncement(status.result);
    // Claim before the first await: the status poll and the alarm can both see the finished task,
    // and only the claimant may post. A failed post releases the claim for a later retry.
    this.ctx.storage.kv.put(ANNOUNCED_KEY, body ? "posting" : "empty");
    if (!body) return;
    let response: Response;
    try {
      // The control plane signs the turn in its engine before replying, which can take a cold start.
      response = await fetch(target.url, { method: "POST", signal: AbortSignal.timeout(150_000),
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" }, body: JSON.stringify({ body }) });
    } catch (cause) {
      // Timeout or transport failure: the turn may already be posted. Keep the claim; never post twice.
      this.ctx.storage.kv.put(ANNOUNCED_KEY, "uncertain");
      console.error({ event: "lane.announce.uncertain", error: cause instanceof Error ? cause.name : "unknown" });
      return;
    }
    if (response.ok) { this.ctx.storage.kv.put(ANNOUNCED_KEY, "posted"); this.ctx.storage.kv.delete(DISCUSSION_KEY); return; }
    // A definite rejection posted nothing: release the claim so a later status check can retry.
    console.error({ event: "lane.announce.rejected", status: response.status });
    this.ctx.storage.kv.delete(ANNOUNCED_KEY);
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
    this.ctx.storage.kv.delete(DISCUSSION_KEY);
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
    if (exitCode !== undefined) return this.#finished(Number.parseInt(exitCode, 10));
    const pid = await this.#readOptionalText(PID_PATH);
    if (pid === undefined) return { state: "none" };
    const probe = await this.#run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid.trim()], "/", {});
    if (probe.exitCode === 0) return { state: "running" };
    const lateExitCode = await this.#readOptionalText(EXIT_CODE_PATH);
    if (lateExitCode !== undefined) return this.#finished(Number.parseInt(lateExitCode, 10));
    return { state: "lost" };
  }

  /**
   * A run that ended successfully but left its work uncommitted or unpushed gets one follow-up turn in
   * the same session, asking it to push or say why not. The sandbox is discarded afterwards, so without
   * this the work is silently lost. The runner never commits or pushes on the agent's behalf.
   */
  async #finished(exitCode: number): Promise<TaskStatus> {
    const outcome = await this.outcome(exitCode);
    const followUp = this.ctx.storage.kv.get<string>(FOLLOW_UP_KEY);
    if (followUp === "started") {
      // The follow-up's closing message is the lane's result; an empty or failed one keeps the first.
      this.ctx.storage.kv.put(FOLLOW_UP_KEY, "done");
      const first = this.ctx.storage.kv.get<string>(FIRST_RESULT_KEY) ?? "";
      return outcome.state === "succeeded" && outcome.result.trim() ? outcome : { state: "succeeded", result: first };
    }
    if (followUp !== undefined || outcome.state !== "succeeded") return outcome;
    // Claim before any await: the alarm and a status poll can both see the finished run.
    this.ctx.storage.kv.put(FOLLOW_UP_KEY, "checked");
    return (await this.#startFollowUp(outcome.result)) ? { state: "running" } : outcome;
  }

  async #startFollowUp(firstResult: string): Promise<boolean> {
    const command = this.continueCommand(FOLLOW_UP_PROMPT, this.ctx.storage.kv.get<string>(MODEL_KEY));
    if (command === undefined) return false;
    const status = await this.#run(STATUS_ARGV, REPOSITORY_DIRECTORY, {});
    const ahead = await this.#run(AHEAD_ARGV, REPOSITORY_DIRECTORY, {});
    if (!hasUnpushedWork({ statusExit: status.exitCode, status: status.stdout, aheadExit: ahead.exitCode, ahead: ahead.stdout })) return false;
    this.ctx.storage.kv.put(FOLLOW_UP_KEY, "started");
    this.ctx.storage.kv.put(FIRST_RESULT_KEY, firstResult);
    await this.#files.remove(EXIT_CODE_PATH, { force: true });
    const task = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...command.argv], {
      cwd: REPOSITORY_DIRECTORY, env: { ...TRUST_ENV, ...command.env }, stdout: "ignore", stderr: "ignore",
    });
    await this.#files.writeFile(PID_PATH, String(task.pid));
    await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
    console.log({ event: "lane.follow_up", agent: this.agent });
    return true;
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
