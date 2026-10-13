// SPDX-License-Identifier: Apache-2.0
export type AgentKind = "agent" | "human" | "reviewer";
export interface Agent { id: string; kind: AgentKind; displayName: string; publicKey: string /*hex ed25519*/;
  email?: string; provider?: string; model?: string; }
export interface Lane { project: string; task: string; agent: string; forkRepo: string; forkRemote: string;
  laneThread: string /* task/<t>/<a> */; lastSeenSha?: string; status: "active"|"released"|"abandoned"; briefing?: Briefing; /** Opened without a briefing, as a control. */ unbriefed?: boolean; }
/** Heddle's signed pre-turn briefing for a lane: earlier decisions' annotations its agent started from. */
export interface Briefing { hash: string /* Heddle briefing_hash */; omitted: number;
  annotations: Array<{ target: string; scope: string; annotationId: string; revisionId: string; kind: string; content: string; tags?: string[]; attribution: string }>; }
export interface Tests { status: "pass"|"fail"|"error"|"skipped"|"pending"; passed: number; failed: number; summary: string; durationMs: number;
  provenance?: "reviewed fixture"|"isolated sandbox"|"isolated sandbox (local fixture)"; sourceSha?: string;
  /** On a failing run: the failing test names and the runner output that explains them. */
  failures?: string[]; excerpt?: string;
  observation?: { publicKey: string; payload: string; signature: string } }
/** Heddle's readiness verdict for a merged state (`heddle ready`). */
export interface HeddleVerdict { status: string; freshness: string; mergeType: string; conflictCount: number; impact: string; impactCategories: string[]; blockers: string[]; }
/**
 * A candidate whose task started before main advanced, merged with the current main by Heddle and
 * tested in the isolated sandbox. Absent when the candidate is current or already contains main.
 */
export interface Combined { mainSha: string; mainState: string; candidateSha: string;
  status: "conflict"|"pending"|"pass"|"fail"|"error"|"skipped"; heddle: HeddleVerdict;
  /** Heddle's own conflicts (`heddle resolve --list`) when it cannot merge cleanly. */
  conflicts: Array<{ path: string; symbol?: string; lines?: [number, number] }>;
  /** The merged native State and its Git projection, for a clean merge. */
  state?: string; sha?: string; treeSha?: string; tests?: Tests; }
export interface Candidate { task: string; agent: string; state: string /*Heddle State id*/;
  sourceSha: string /*agent's commit*/; treeSha: string; parentSha: string; subject: string;
  diffstat: { files: number; insertions: number; deletions: number };
  tests?: Tests;
  combined?: Combined;
  conflicts: Array<{ path: string; region?: string; with: string[] /*other agent ids*/ }>;
  signedBy: string /*pubkey hex*/; capturedAt: string; }
/** Descriptions and symbol names come directly from Heddle's semantic diff. */
export interface SemanticChange { change_type: string; description: string; path?: string; from_path?: string; to_path?: string;
  old_name?: string; new_name?: string; importance?: string; }
export type CaptureSemantic = { status: 'ready'; changes: SemanticChange[] } | { status: 'pending' | 'unavailable' };
export interface Capture extends Candidate { fromState: string; semantic: CaptureSemantic; }
export interface CaptureHistory { task: string; lanes: Array<{ agent: string; openedAt?: string /* when the engine opened the lane; absent on older lanes */; captures: Capture[] }>; pending: number; }
/** Internal hint: the worker snapshots newly computed semantic cache entries before returning. */
export interface EngineCaptureHistory extends CaptureHistory { cacheChanged: boolean; }
export interface Turn { id: string; task: string; author: string; kind: AgentKind; body: string; replyTo?: string;
  heddleDiscussion: string; signedBy: string; at: string; }
export interface Decision { task: string; decider: string; pick: string /*agent id*/; rationale: string; anchor?: string; tags?: string[];
  alternatives: string[]; resolutionState: string; landState: string; mainSha: string; at: string;
  /** Set when the pick landed as Heddle's merge with main: the tested combined commit. */
  combined?: { sha: string; treeSha: string; mainSha: string; state: string }; }
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
