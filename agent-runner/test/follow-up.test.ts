// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AHEAD_ARGV, FOLLOW_UP_PROMPT, STATUS_ARGV, hasUnpushedWork } from "../src/follow-up.ts";

const clean = { statusExit: 0, status: "", aheadExit: 0, ahead: "0\n" };

test("only work that is known to be unpushed earns a follow-up turn", () => {
  assert.equal(hasUnpushedWork(clean), false, "nothing to push");
  assert.equal(hasUnpushedWork({ ...clean, status: " M languages/lua/src/grammar.ts\n?? languages/lua/test/strings.lua\n" }), true, "uncommitted changes");
  assert.equal(hasUnpushedWork({ ...clean, ahead: "3\n" }), true, "local commits not on origin");
  assert.equal(hasUnpushedWork({ ...clean, statusExit: 128, status: "fatal: not a git repository" }), false, "git could not answer");
  assert.equal(hasUnpushedWork({ ...clean, aheadExit: 128, ahead: "fatal: bad revision" }), false, "no origin/main to compare");
});

test("the follow-up asks the agent to push or explain, never pushes for it", () => {
  assert.match(FOLLOW_UP_PROMPT, /git push origin HEAD:main/);
  assert.match(FOLLOW_UP_PROMPT, /push nothing and say exactly what is missing/);
});

test("real git: installed node_modules and pushed work need no follow-up; a new file or an unpushed commit does", () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "follow-up-")), git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    const origin = join(root, "origin.git"), repo = join(root, "repo");
    git(root, "init", "-q", "--bare", "-b", "main", origin); git(root, "clone", "-q", origin, repo);
    git(repo, "config", "user.name", "t"); git(repo, "config", "user.email", "t@t");
    writeFileSync(join(repo, "README.md"), "x\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base"); git(repo, "push", "-q", "origin", "HEAD:main");
    const state = () => { const s = spawnSync(STATUS_ARGV[0], STATUS_ARGV.slice(1), { cwd: repo, encoding: "utf8" }), a = spawnSync(AHEAD_ARGV[0], AHEAD_ARGV.slice(1), { cwd: repo, encoding: "utf8" });
      return hasUnpushedWork({ statusExit: s.status ?? 1, status: s.stdout, aheadExit: a.status ?? 1, ahead: a.stdout }); };
    mkdirSync(join(repo, "node_modules", "vitest"), { recursive: true }); writeFileSync(join(repo, "node_modules", "vitest", "index.js"), "");
    mkdirSync(join(repo, "packages", "a", "node_modules"), { recursive: true }); writeFileSync(join(repo, "packages", "a", "node_modules", "x.js"), "");
    assert.equal(state(), false, "only installed dependencies, nothing authored");
    writeFileSync(join(repo, "grammar.ts"), "export {};\n");
    assert.equal(state(), true, "a new source file");
    git(repo, "add", "grammar.ts"); git(repo, "commit", "-qm", "grammar");
    assert.equal(state(), true, "committed but not pushed");
    git(repo, "push", "-q", "origin", "HEAD:main");
    assert.equal(state(), false, "pushed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
