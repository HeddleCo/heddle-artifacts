// SPDX-License-Identifier: Apache-2.0
export type AgentKind = "agent" | "human" | "reviewer";
export interface Agent { id: string; kind: AgentKind; displayName: string; publicKey: string /*hex ed25519*/;
  provider?: string; model?: string; }
export interface Lane { project: string; task: string; agent: string; forkRepo: string; forkRemote: string;
  laneThread: string /* task/<t>/<a> */; lastSeenSha?: string; status: "active"|"released"|"abandoned"; briefing?: Briefing; /** Opened without a briefing, as a control. */ unbriefed?: boolean; }
/** Heddle's signed pre-turn briefing for a lane: earlier decisions' annotations its agent started from. */
export interface Briefing { hash: string /* Heddle briefing_hash */; omitted: number;
  annotations: Array<{ target: string; scope: string; annotationId: string; revisionId: string; kind: string; content: string; attribution: string }>; }
export interface Candidate { task: string; agent: string; state: string /*Heddle State id*/;
  sourceSha: string /*agent's commit*/; treeSha: string; parentSha: string; subject: string;
  diffstat: { files: number; insertions: number; deletions: number };
  tests?: { status: "pass"|"fail"|"error"|"skipped"|"pending"; passed: number; failed: number; summary: string; durationMs: number;
    provenance?: "reviewed fixture"|"isolated sandbox"|"isolated sandbox (local fixture)"; sourceSha?: string;
    observation?: { publicKey: string; payload: string; signature: string } };
  conflicts: Array<{ path: string; region?: string; with: string[] /*other agent ids*/ }>;
  signedBy: string /*pubkey hex*/; capturedAt: string; }
export interface Turn { id: string; task: string; author: string; kind: AgentKind; body: string; replyTo?: string;
  heddleDiscussion: string; signedBy: string; at: string; }
export interface Decision { task: string; decider: string; pick: string /*agent id*/; rationale: string;
  alternatives: string[]; resolutionState: string; landState: string; mainSha: string; at: string; }
export type FeedEvent =
  | { type: "push.received"; task: string; agent: string; sha: string; via: "event"|"poll" }
  | { type: "candidate.ready"; candidate: Candidate }
  | { type: "tests.done"; task: string; agent: string; sourceSha?: string; tests: Candidate["tests"] }
  | { type: "review.posted"; turn: Turn; review: Review }
  | { type: "discussion.posted"; turn: Turn }
  | { type: "decision.landed"; decision: Decision }
  | { type: "engine.error"; op: string; code: string; message: string };
export interface Review { summary: string;
  perCandidate: Array<{ agent: string; verdict: "approve"|"concerns"; notes: string }>;
  recommendation?: { pick: string; why: string }; model: string; }
