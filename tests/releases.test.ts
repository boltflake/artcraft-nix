// Release naming (scripts/lib/releases.ts), reconcile (scripts/ci/reconcile.ts)
// and publish's attempts (scripts/ci/publish.ts), against real git
// repositories and the in-memory GitHub client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocate, changesBetween, firstParent, needsRelease, trailerOf, TRAILER } from "../scripts/lib/releases.ts";
import { reconcile } from "../scripts/ci/reconcile.ts";
import { publish } from "../scripts/ci/publish.ts";
import { Fake } from "./fake-gh.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "releases-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "versions"));
  return dir;
}
const pin = (repoName: string, version: string) => JSON.stringify({ repo: repoName, version, tag: `v${version}`, packages: { [repoName]: {} } }, null, 2) + "\n";
function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

test("names: YYYY.MM.DD.N, N one more than the day's highest trailer", () => {
  const now = new Date("2026-11-22T10:00:00Z");
  assert.equal(allocate([], now), "2026.11.22.1");
  assert.equal(allocate(["2026.11.21.4", "2026.11.22.1", "2026.11.22.2"], now), "2026.11.22.3");
  assert.equal(allocate(["2026.11.22.9", "2026.11.22.10"], now), "2026.11.22.11");
});

test("two publishes before reconcile runs: the second counts the first's trailer", () => {
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, "first pins");
  const now = new Date("2026-11-22T10:00:00Z");
  const a = allocate(firstParent("HEAD", dir).map((c) => c.trailer!).filter(Boolean), now);
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.1.0") }, `Update photocraft\n\n${TRAILER}: ${a}`);
  const b = allocate(firstParent("HEAD", dir).map((c) => c.trailer!).filter(Boolean), new Date("2026-11-22T10:07:00Z"));
  assert.deepEqual([a, b], ["2026.11.22.1", "2026.11.22.2"]);
});

test("a re-dispatch across midnight UTC allocates again on the new base, with the new date", () => {
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `Update\n\n${TRAILER}: 2026.11.22.3`);
  const trailers = firstParent("HEAD", dir).map((c) => c.trailer!).filter(Boolean);
  assert.equal(allocate(trailers, new Date("2026-11-22T23:59:30Z")), "2026.11.22.4");
  assert.equal(allocate(trailers, new Date("2026-11-23T00:00:30Z")), "2026.11.23.1");
});

test("trailers: only the last paragraph's, only well-formed names", () => {
  assert.equal(trailerOf(`Update x\n\n${TRAILER}: 2026.11.22.1\n`), "2026.11.22.1");
  assert.equal(trailerOf(`Update x\n\n${TRAILER}: 2026.11.22.1\n\nMore text`), null);
  assert.equal(trailerOf(`Update x\n\n${TRAILER}: v1`), null);
});

test("what gets a release: a version that moves among the changes given (publish leaves the nixpkgs moves out by kind); not a same-tag re-pin or a marker", () => {
  assert.equal(needsRelease([]), false, "the nixpkgs moves are left out by their kind (publish)");
  assert.equal(needsRelease([{ repo: "photocraft", from: "1.0.0", to: "1.0.0" }]), false);
  assert.equal(needsRelease([{ repo: "photocraft", from: "1.0.0", to: "1.1.0" }]), true);
});

test("reconcile rebuilds lost tags and releases in history order, and lists a hand re-pin in the next release", async () => {
  const dir = repo();
  const c1 = commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0"), "versions/figcraft.json": pin("figcraft", "2.0.0") }, `First pins\n\n${TRAILER}: 2026.11.20.1`);
  // A hand re-pin: no trailer.
  commit(dir, { "versions/figcraft.json": pin("figcraft", "2.0.1") }, "Re-pin figcraft by hand");
  const c3 = commit(dir, { "versions/photocraft.json": pin("photocraft", "1.1.0") }, `Update photocraft\n\n${TRAILER}: 2026.11.21.1`);
  const gh = new Fake();
  const commits = firstParent("HEAD", dir);
  const obs = await reconcile(gh, "HEAD", commits, undefined, "/nonexistent");
  // Default body reads pins with git in the cwd; use a body that records order instead.
  assert.ok(obs.some((o) => o.kind === "tag-ok"));
  assert.deepEqual(gh.releaseList.map((r) => r.tag), ["2026.11.20.1", "2026.11.21.1"]);
  assert.equal(gh.refMap["refs/tags/2026.11.20.1"], c1);
  assert.equal(gh.refMap["refs/tags/2026.11.21.1"], c3);
  assert.equal(gh.latest, "2026.11.21.1");
  // The second release's changes include the hand re-pin in between.
  const changes = changesBetween(commits, c1, c3, (sha) => new Map(["photocraft", "figcraft"].map((r) => [r, JSON.parse(git(dir, "show", `${sha}:versions/${r}.json`))])));
  assert.deepEqual(changes.map((c) => `${c.repo} ${c.from} -> ${c.to}`), ["figcraft 2.0.0 -> 2.0.1", "photocraft 1.0.0 -> 1.1.0"]);
  // Idempotent.
  await reconcile(gh, "HEAD", commits, () => "body");
  assert.equal(gh.releaseList.length, 2);
});

test("reconcile reports a conflicting tag and never moves it", async () => {
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `First\n\n${TRAILER}: 2026.11.20.1`);
  const gh = new Fake();
  gh.refMap["refs/tags/2026.11.20.1"] = "f".repeat(40);
  const obs = await reconcile(gh, "HEAD", firstParent("HEAD", dir), () => "body");
  assert.ok(obs.some((o) => o.kind === "tag-mismatch"));
  assert.equal(gh.refMap["refs/tags/2026.11.20.1"], "f".repeat(40));
  assert.equal(gh.releaseList.length, 0);
});

test("Latest goes on the newest trailer commit, also after a downgrade", async () => {
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.1.0") }, `Up\n\n${TRAILER}: 2026.11.20.1`);
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `Back (1.1.0 pulled)\n\n${TRAILER}: 2026.11.21.1`);
  const gh = new Fake();
  // The newer one's release was lost and rebuilt after the downgrade's.
  gh.refMap["refs/tags/2026.11.21.1"] = git(dir, "rev-parse", "HEAD");
  gh.releaseList.push({ id: 1, tag: "2026.11.21.1", target: git(dir, "rev-parse", "HEAD"), name: "2026.11.21.1", body: "" });
  await reconcile(gh, "HEAD", firstParent("HEAD", dir), () => "body");
  assert.deepEqual(gh.releaseList.map((r) => r.tag), ["2026.11.21.1", "2026.11.20.1"]);
  assert.equal(gh.latest, "2026.11.21.1");
  assert.equal(gh.marked, "2026.11.21.1", "marked, since GitHub would otherwise take the newest made");
});

// Publish: a bare remote as origin, a candidate dir as candidate.ts writes it.
function publishSetup() {
  const remote = mkdtempSync(join(tmpdir(), "remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `First\n\n${TRAILER}: 2026.11.22.1`);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  const base = git(dir, "rev-parse", "HEAD");
  const cand = mkdtempSync(join(tmpdir(), "candidate-"));
  mkdirSync(join(cand, "files", "versions"), { recursive: true });
  writeFileSync(join(cand, "files", "versions", "photocraft.json"), pin("photocraft", "1.1.0"));
  writeFileSync(join(cand, "inputs.json"), JSON.stringify({ base, inputs: [{ name: "photocraft", files: ["versions/photocraft.json"], from: "1.0.0", to: "1.1.0" }] }));
  return { remote, dir, cand, base };
}
const inDir = async <T>(dir: string, f: () => Promise<T>): Promise<T> => {
  const old = process.cwd();
  process.chdir(dir);
  try { return await f(); } finally { process.chdir(old); }
};
const treeOf = (dir: string, cand: string) => inDir(dir, async () => (await import("../scripts/ci/candidate.ts")).tree(cand, "photocraft"));

test("publish: main fast-forwards, with the release trailer and its tag pushed together, and `tested` posted", async () => {
  const { remote, dir, cand } = publishSetup();
  const gh = new Fake();
  const t = await treeOf(dir, cand);
  const r = await inDir(dir, () => publish(cand, ["photocraft"], t, gh, { ATTEMPT: "0" }, "origin", null, new Date("2026-11-22T12:00:00Z")));
  assert.equal(r.release, "2026.11.22.2");
  const head = execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "2026.11.22.2"], { encoding: "utf8" }).trim(), head);
  assert.match(execFileSync("git", ["-C", remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }), /Artcraft-Release: 2026\.11\.22\.2/);
  assert.deepEqual(gh.statuses.map((s) => s[1]), ["tested"]);
});

test("publish: main moved meanwhile, so it re-dispatches with the next attempt; at the third it gives up", async () => {
  const { dir, cand, remote } = publishSetup();
  // Someone else moves main.
  const other = mkdtempSync(join(tmpdir(), "other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  commit(other, { "README": "x" }, "hand commit");
  git(other, "push", "-q", "origin", "main");
  const t = await treeOf(dir, cand);
  const gh = new Fake();
  const r = await inDir(dir, () => publish(cand, ["photocraft"], t, gh, { ATTEMPT: "0" }, "origin"));
  assert.ok(r.observations.some((o) => o.kind === "redispatched") && r.observations.some((o) => o.kind === "main-moved"));
  assert.deepEqual(gh.dispatches, [["update.yml", "main", { attempt: "1" }]]);
  const gh2 = new Fake();
  const r2 = await inDir(dir, () => publish(cand, ["photocraft"], t, gh2, { ATTEMPT: "2" }, "origin"));
  assert.ok(r2.observations.some((o) => o.kind === "update-failed") && r2.observations.some((o) => o.kind === "main-moved"), "giving up says main moved too");
  assert.deepEqual(gh2.dispatches, []);
});

test("publish refuses a tree that isn't the tested one", async () => {
  const { dir, cand } = publishSetup();
  await assert.rejects(inDir(dir, () => publish(cand, ["photocraft"], "0".repeat(40), new Fake(), {}, "origin")), /not the tested tree/);
});

test("a release body lists every package at the commit, the changes since the last one, and how to pin it", async () => {
  const { releaseBody } = await import("../scripts/lib/releases.ts");
  const pins = new Map([["pdfcraft", { repo: "pdfcraft", version: "0.21.1", tag: "v0.21.1", packages: { pdfcraft: {}, "pdfcraft-cli": {} },
    unavailable: { since: "x", issue: 1, packages: ["pdfcraft-cli"] } } as any]]);
  const body = releaseBody("2026.11.22.2", "abc", pins, [{ repo: "pdfcraft", from: "0.21.2", to: "0.21.1", tag: "v0.21.1" }], false);
  assert.match(body, /pdfcraft 0.21.2 → \[0.21.1\]\(https:\/\/github.com\/storytold\/pdfcraft\/releases\/tag\/v0.21.1\) \(back to an earlier release/);
  assert.match(body, /\| pdfcraft-cli \| \[0.21.1\].* \(unavailable\) \|/);
  assert.match(body, /github:boltflake\/artcraft-nix\/2026.11.22.2/);
  assert.match(releaseBody("2026.11.20.1", "abc", pins, [], true), /The first release: every package's initial pin/);
});

test("the timing trailers: queue is elapsed time less the queue-free critical path; waited counts only behind a real run", async () => {
  const { timingOf, commitMessage } = await import("../scripts/ci/publish.ts");
  const run = { id: 9, created_at: "2026-11-22T10:00:00Z", run_started_at: "2026-11-22T10:02:00Z" };
  const job = (name: string, started: string, completed: string | null) => ({ name, started_at: `2026-11-22T${started}Z`, completed_at: completed && `2026-11-22T${completed}Z` });
  const jobs = [
    job("resolve", "10:02:10", "10:03:00"),                          // 50 s
    job("test (x86_64-linux, apps1)", "10:03:05", "10:07:05"),        // 240 s: the longest test job
    job("test (aarch64-linux, studio)", "10:04:30", "10:08:00"),      // started late, finished last: 210 s
    job("narrow-plan", "10:08:02", "10:08:20"),                      // 18 s
    job("publish", "10:08:25", null),                                // to now: 35 s
  ];
  const now = Date.parse("2026-11-22T10:09:00Z");
  // path = 50 + 240 + 18 + 35 = 343 s; elapsed = 420 s.
  assert.deepEqual(timingOf(run, jobs, [], now), { queue: 420 - 343, waited: 0 });
  const ahead = [{ id: 8, display_title: "update", run_started_at: "2026-11-22T09:55:00Z", status: "completed", updated_at: "2026-11-22T10:01:50Z" }];
  assert.equal(timingOf(run, jobs, ahead, now)!.waited, 120);
  const dryAhead = [{ ...ahead[0], display_title: "update (dry run)" }];
  assert.equal(timingOf(run, jobs, dryAhead, now)!.waited, 0, "a dry run isn't one ahead");
  assert.equal(timingOf(run, [{ name: "resolve", started_at: null, completed_at: null }], [], now), null, "missing timing: no sample");
  const msg = commitMessage([{ name: "photocraft", files: [], from: "1", to: "2" }], ["photocraft"], "2026.11.22.1", false, { queue: 47, waited: 0 });
  assert.match(msg, /\n\nArtcraft-Release: 2026\.11\.22\.1\nArtcraft-Queue: 47\nArtcraft-Waited: 0$/);
  assert.equal(trailerOf(msg), "2026.11.22.1");
});

test("reconcile: a conflicting tag on the newest release blocks Latest (reported, no stand-in); leftover candidate refs of finished runs go", async () => {
  const dir = repo();
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `First\n\n${TRAILER}: 2026.11.20.1`);
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.1.0") }, `Up\n\n${TRAILER}: 2026.11.21.1`);
  const gh = new Fake();
  gh.refMap["refs/tags/2026.11.21.1"] = "e".repeat(40);
  gh.refMap["refs/heads/bot/candidate/123"] = "a".repeat(40);
  gh.refMap["refs/heads/bot/candidate/456"] = "b".repeat(40);
  gh.completed.add("123");
  const obs = await reconcile(gh, "HEAD", firstParent("HEAD", dir), () => "body", "/nonexistent");
  assert.ok(obs.some((o) => o.kind === "latest-mismatch" && o.version === "2026.11.21.1"));
  assert.ok(!obs.some((o) => o.kind === "latest-match"));
  assert.equal(gh.marked, null);
  assert.ok(!("refs/heads/bot/candidate/123" in gh.refMap));
  assert.ok("refs/heads/bot/candidate/456" in gh.refMap, "a run still going keeps its ref");
});

test("publish: a re-run after its commit landed counts as done, with the landing's evidence (env-ok, test-passed)", async () => {
  const { remote, dir, cand } = publishSetup();
  const t = await treeOf(dir, cand);
  const first = await inDir(dir, () => publish(cand, ["photocraft"], t, new Fake(), { ATTEMPT: "0", RUN_ID: "77" }, "origin", null, new Date("2026-11-22T12:00:00Z")));
  assert.ok(first.observations.some((o) => o.kind === "env-ok"));
  assert.ok(first.observations.some((o) => o.kind === "test-passed" && o.repo === "photocraft"));
  // The job is re-run (its checkout is the base again).
  const gh = new Fake();
  const again = await inDir(dir, () => publish(cand, ["photocraft"], t, gh, { ATTEMPT: "0", RUN_ID: "77" }, "origin", null, new Date("2026-11-22T12:05:00Z")));
  assert.deepEqual(gh.dispatches, [], "no re-dispatch");
  assert.equal(again.release, "2026.11.22.2", "the recovered release name");
  assert.ok(again.observations.some((o) => o.kind === "published" && o.version === "2026.11.22.2"));
  assert.ok(again.observations.some((o) => o.kind === "test-passed"));
  assert.equal(execFileSync("git", ["-C", remote, "rev-list", "--count", "main"], { encoding: "utf8" }).trim(), "2");
});

test("publish: another run's commit of the same tree isn't mistaken for this run's", async () => {
  const { dir, cand } = publishSetup();
  const t = await treeOf(dir, cand);
  await inDir(dir, () => publish(cand, ["photocraft"], t, new Fake(), { ATTEMPT: "0", RUN_ID: "77" }, "origin", null, new Date("2026-11-22T12:00:00Z")));
  const gh = new Fake();
  const other = await inDir(dir, () => publish(cand, ["photocraft"], t, gh, { ATTEMPT: "0", RUN_ID: "78" }, "origin", null, new Date("2026-11-22T12:05:00Z")));
  assert.deepEqual(gh.dispatches, [["update.yml", "main", { attempt: "1" }]]);
  assert.ok(other.observations.some((o) => o.kind === "redispatched"));
});

test("publish: a snapshot catch-up alone lands only when the move passes, with no release name", async () => {
  const remote = mkdtempSync(join(tmpdir(), "remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = repo();
  mkdirSync(join(dir, "versions", "stable"), { recursive: true });
  commit(dir, { "versions/photocraft.json": pin("photocraft", "1.1.0"), "versions/stable/photocraft.json": pin("photocraft", "1.0.0") }, `Up\n\n${TRAILER}: 2026.11.22.1`);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  const base = git(dir, "rev-parse", "HEAD");
  const cand = mkdtempSync(join(tmpdir(), "candidate-"));
  writeFileSync(join(cand, "inputs.json"), JSON.stringify({ base, inputs: [{ name: "stable-snapshot", files: [], from: null, to: null }] }));
  const t = git(dir, "rev-parse", "HEAD^{tree}");
  const failed = await inDir(dir, () => publish(cand, ["stable-snapshot"], t, new Fake(), { ATTEMPT: "0" }, "origin",
    { move: false, reason: "stable-next failed: x", stable: "pass", stableFailed: [], decided: true } as any));
  assert.equal(failed.release, null);
  assert.equal(git(remote, "rev-parse", "main"), base, "nothing lands");
  assert.ok(failed.observations.some((o) => o.kind === "stable-behind" && /stable-next failed/.test(o.detail) && o.fingerprint === `tree:${t}`),
    "a complete turn-down carries the tree, so idle runs don't retry it");
  const unknown = await inDir(dir, () => publish(cand, ["stable-snapshot"], t, new Fake(), { ATTEMPT: "0" }, "origin",
    { move: false, reason: "stable-next's results are incomplete", stable: "pass", stableFailed: [], decided: false } as any));
  assert.equal(unknown.observations.find((o) => o.kind === "stable-behind")!.fingerprint, undefined, "incomplete: retried");
  assert.ok(!failed.observations.some((o) => o.kind === "published"));
  const moved = await inDir(dir, () => publish(cand, ["stable-snapshot"], t, new Fake(), { ATTEMPT: "0" }, "origin",
    { move: true, reason: "ok", stable: "pass", stableFailed: [] } as any));
  assert.equal(moved.release, null);
  const msg = git(remote, "log", "-1", "--format=%B", "main");
  assert.match(msg, /^NixOS stable: catch the snapshot up with main/);
  assert.doesNotMatch(msg, new RegExp(TRAILER));
  assert.equal(git(remote, "show", "main:versions/stable/photocraft.json"), git(remote, "show", "main:versions/photocraft.json"));
  assert.ok(moved.observations.some((o) => o.kind === "stable-current"), JSON.stringify(moved.observations));
  assert.ok(!moved.observations.some((o) => o.kind === "test-passed"));
  // Main has moved since (here, by that catch-up): a failed catch-up of the
  // old tree says nothing.
  const stale = await inDir(dir, () => publish(cand, ["stable-snapshot"], t, new Fake(), { ATTEMPT: "0" }, "origin",
    { move: false, reason: "stable-next failed: x", stable: "fail", stableFailed: ["x"], decided: true } as any));
  assert.deepEqual(stale.observations.map((o) => o.kind), ["main-moved"], "only that main moved (issues.ts drops the old tree's evidence)");
});

test("publish: a marker-only input lands with no release name and passes no release", async () => {
  const { dir, cand, base } = publishSetup();
  const marked = JSON.stringify({ ...JSON.parse(pin("photocraft", "1.0.0")), unavailable: { since: "2026-11-22T00:00:00Z", issue: null, packages: ["photocraft"] } }, null, 2) + "\n";
  writeFileSync(join(cand, "files", "versions", "photocraft.json"), marked);
  writeFileSync(join(cand, "inputs.json"), JSON.stringify({ base, inputs: [{ name: "photocraft", files: ["versions/photocraft.json"], from: "1.0.0", to: "1.0.0", fingerprint: "fp", markerOnly: true }] }));
  const t = await treeOf(dir, cand);
  const r = await inDir(dir, () => publish(cand, ["photocraft"], t, new Fake(), { ATTEMPT: "0" }, "origin"));
  assert.equal(r.release, null);
  assert.ok(r.observations.some((o) => o.kind === "published"));
  assert.ok(!r.observations.some((o) => o.kind === "test-passed"), "a hold on another photocraft release stays");
});

test("publish: main moved and the re-dispatch fails: main-moved still reaches the issues job", async () => {
  const { dir, cand, remote } = publishSetup();
  const other = mkdtempSync(join(tmpdir(), "other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  commit(other, { "README": "x" }, "hand commit");
  git(other, "push", "-q", "origin", "main");
  const t = await treeOf(dir, cand);
  const gh = new Fake();
  gh.dispatch = async () => { throw new Error("HTTP 502"); };
  const r = await inDir(dir, () => publish(cand, ["photocraft"], t, gh, { ATTEMPT: "0" }, "origin"));
  assert.deepEqual(r.observations.map((o) => o.kind), ["main-moved", "update-failed"]);
});

test("publish: only kinds that need a release name get one (a renamed stable pin doesn't)", async () => {
  const { dir, cand, base } = publishSetup();
  writeFileSync(join(cand, "inputs.json"), JSON.stringify({ base, inputs: [{ name: "renamed-pin", kind: "stable-pin", files: ["versions/photocraft.json"], from: "a", to: "b" }] }));
  const t = await inDir(dir, async () => (await import("../scripts/ci/candidate.ts")).tree(cand, "renamed-pin"));
  const r = await inDir(dir, () => publish(cand, ["renamed-pin"], t, new Fake(), { ATTEMPT: "0" }, "origin"));
  assert.equal(r.release, null);
});

test("reconcile reports a release-name tag no trailer names, and never touches it", async () => {
  const dir = repo();
  const c1 = commit(dir, { "versions/photocraft.json": pin("photocraft", "1.0.0") }, `First\n\n${TRAILER}: 2026.11.22.1`);
  const gh = new Fake();
  gh.refMap["refs/tags/2026.11.22.2"] = c1;
  const obs = await reconcile(gh, "HEAD", firstParent("HEAD", dir), () => "body", "/nonexistent");
  assert.ok(obs.some((o) => o.kind === "tag-mismatch" && o.version === "2026.11.22.2"));
  assert.ok(!obs.some((o) => o.kind === "tag-ok"));
  assert.equal(gh.refMap["refs/tags/2026.11.22.2"], c1);
});

test("publish: a release name a stray tag holds is skipped, not blocked on", async () => {
  const { remote, dir, cand, base } = publishSetup();
  git(dir, "tag", "2026.11.22.2", base);
  git(dir, "push", "-q", "origin", "2026.11.22.2");
  const t = await treeOf(dir, cand);
  const r = await inDir(dir, () => publish(cand, ["photocraft"], t, new Fake(), { ATTEMPT: "0" }, "origin", null, new Date("2026-11-22T12:00:00Z")));
  assert.equal(r.release, "2026.11.22.3");
  assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "2026.11.22.2"], { encoding: "utf8" }).trim(), base, "the stray tag stays");
});

test("refs: an annotated release tag is peeled to its commit", async () => {
  const { GitHub } = await import("../scripts/ci/gh.ts");
  const real = globalThis.fetch;
  const answers: Record<string, unknown> = {
    "git/matching-refs/tags/20": [
      { ref: "refs/tags/2026.11.22.1", object: { sha: "c".repeat(40), type: "commit" } },
      { ref: "refs/tags/2026.11.22.2", object: { sha: "t".repeat(40), type: "tag" } },
    ],
    [`git/tags/${"t".repeat(40)}`]: { object: { sha: "d".repeat(40), type: "commit" } },
  };
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\//, "");
    return new Response(JSON.stringify(answers[path]), { status: path in answers ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    assert.deepEqual(await new GitHub("o/r", "tok").refs("tags/20"), { "refs/tags/2026.11.22.1": "c".repeat(40), "refs/tags/2026.11.22.2": "d".repeat(40) });
  } finally {
    globalThis.fetch = real;
  }
});
