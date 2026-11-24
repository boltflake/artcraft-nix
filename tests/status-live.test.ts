// The status page's live view (scripts/status-live.ts), the watcher's reply
// as it reads it (scripts/lib/watcher-health.ts) and the secretless reads
// behind it (scripts/ci/status-reads.ts). The zip tests are t3code-nix's.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { explaining, incomplete, liveView, PULLED, PULLED_STAYS, SAME_TAG, waitFor, type OpenIssue, type Run } from "../scripts/status-live.ts";
import { pinFingerprint } from "../scripts/update.ts";
import { sourceOf } from "../shared/sources.ts";
import { upstream } from "../scripts/lib/watcher-health.ts";
import { candidateInputs, capped, inputsJson, MAX_MEMBER, MAX_ZIP, metaOf, readIssues, readRuns } from "../scripts/ci/status-reads.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pin } from "../scripts/lib/util.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
/** The watcher's /health reply (its state), a repository each: [eligible
 * version, last full read?, extra fields]. */
const health = (repos: Record<string, string | null | [string | null, string?, object?]>, written = "2026-11-13T11:58:00Z") => ({
  deployed: "w1",
  state: { written, deployed: "w1", pins: { oid: null, tags: {} }, poll: {}, dispatch: { pending: false },
    repos: Object.fromEntries(Object.entries(repos).map(([repo, v]) => {
      const [version, read, extra] = Array.isArray(v) ? v : [v];
      return [repo, { pinned: null, eligible: version === null ? null : { tag: `v${version}`, version, fingerprint: "f", firstSeen: "2026-11-13T11:00:00Z" }, waiting: {},
        read: read ?? "2026-11-13T11:55:00Z", ...extra }];
    })) },
});
const failing = { error: { kind: "http", message: "HTTP 502", since: "2026-11-13T11:00:00Z" } };
const asset = { url: "u", hash: "h", assetId: 1, digest: "d" };
const pin = (repo: string, version: string, pkgs: string[] = [repo], extra: Partial<Pin> = {}): Pin => ({
  repo, version, tag: repo === "artcraft" ? `artcraft-v${version}` : `v${version}`, releaseId: 1, manifest: { assetId: 1, digest: "d" }, signature: { assetId: 1, digest: "d" },
  packages: Object.fromEntries(pkgs.map((p) => [p, { "x86_64-linux": asset, "aarch64-linux": asset }])), ...extra });
const issue = (number: number, kind: string, repo: string | null, version: string | null): OpenIssue => ({ number, kind, repo, version });
const states = (pins: Pin[], h: any, runs: Run[] = [], issues: OpenIssue[] = []) => liveView(pins, h, runs, issues, "o/r", NOW)?.states;

test("health: the heartbeat, each repository's freshness and errors, and the checked time", () => {
  assert.equal(upstream(null, NOW), null);
  assert.equal(upstream({ state: { repos: {} } }, NOW), null, "not a reply the backstop can read");
  assert.equal(upstream(health({ photocraft: "1.0.0" }, "2026-11-13T11:20:00Z"), NOW), null, "a stale heartbeat: nothing can be trusted");
  assert.equal(upstream(health({ photocraft: "1.0.0" }, "2026-11-13T12:06:00Z"), NOW), null, "too far ahead of our clock");
  const up = upstream(health({ photocraft: ["1.0.0", "2026-11-13T11:40:00Z"], vectorcraft: ["2.0.0", "2026-11-13T11:57:00Z"],
    pdfcraft: ["3.0.0", undefined, failing], figcraft: ["1.0.0", "2026-11-13T11:00:00Z"], lightcraft: null, nonsense: "9.9.9" }), NOW)!;
  assert.deepEqual([...up.versions], [["photocraft", "1.0.0"], ["vectorcraft", "2.0.0"]], "an error, a stale read and no eligible release give no version");
  assert.equal(up.checked, "2026-11-13T11:40:00.000Z", "the oldest full read that counts");
  assert.equal(up.firstSeen.get("photocraft"), "2026-11-13T11:00:00.000Z");
  assert.equal(upstream(health({ photocraft: null }), NOW)!.checked, "2026-11-13T11:58:00.000Z", "none counts: the heartbeat");
});

test("live: current, found, not checked, and a companion sharing its app's state", () => {
  const pins = [pin("photocraft", "0.23.1"), pin("pdfcraft", "0.21.1", ["pdfcraft", "pdfcraft-cli"]), pin("cadcraft", "0.20.1"), pin("artcraft", "0.41.1", ["artcraft-studio"])];
  const s = states(pins, health({ photocraft: "0.23.1", pdfcraft: "0.21.2", artcraft: "0.41.2", cadcraft: ["0.20.1", undefined, failing] }))!;
  assert.deepEqual(s.photocraft, { state: "current" });
  assert.deepEqual(s.pdfcraft, { state: "found", version: "0.21.2", wait: "waiting for the next run", since: "2026-11-13T11:00:00.000Z", link: "https://github.com/storytold/pdfcraft/releases/tag/v0.21.2" });
  assert.deepEqual(s["pdfcraft-cli"], s.pdfcraft);
  assert.equal(s["artcraft-studio"].link, "https://github.com/storytold/artcraft/releases/tag/artcraft-v0.41.2", "Studio's tag prefix");
  assert.deepEqual(s.cadcraft, { state: "not-checked" });
  assert.equal(states(pins, health({}, "2026-11-13T10:00:00Z")), undefined, "a stale heartbeat: no live view at all");
});

test("live: testing from the newest unfinished run's candidate, before held", () => {
  const pins = [pin("photocraft", "0.23.1")];
  const runs: Run[] = [{ id: 1, created: "2026-11-13T11:00:00Z", inputs: [{ name: "photocraft", version: "0.23.2" }] },
    { id: 2, created: "2026-11-13T11:30:00Z", inputs: [{ name: "photocraft", version: "0.23.3" }] },
    { id: 3, created: "2026-11-13T11:40:00Z", inputs: [{ name: "photocraft", version: "0.23.1" }] }];
  const s = states(pins, health({ photocraft: "0.23.3" }), runs, [issue(9, "test-failed", "photocraft", "0.23.3")])!;
  assert.deepEqual(s.photocraft, { state: "testing", version: "0.23.3", since: "2026-11-13T11:30:00.000Z", link: "https://github.com/o/r/actions/runs/2" });
});

test("live: held, and which issue explains it", () => {
  const pins = [pin("figcraft", "0.18.1", ["figcraft", "figcraft-server"])];
  const h = health({ figcraft: "0.18.2" });
  const held = (issues: OpenIssue[]) => states(pins, h, [], issues)!.figcraft;
  assert.deepEqual(held([issue(41, "test-failed", "figcraft", "0.18.2")]),
    { state: "held", version: "0.18.2", reason: "tests failed", since: "2026-11-13T11:00:00.000Z", link: "https://github.com/o/r/issues/41" });
  assert.equal(held([issue(5, "integrity", "figcraft", "0.18.2")]).reason, "files or signature don't verify");
  assert.equal(held([issue(5, "combination-failed", "figcraft", "0.18.2")]).reason, "failed together with another update");
  // Most specific first: the version's own issue over resolve-failed, over env-broken.
  assert.equal(explaining("figcraft", "0.18.2", [issue(3, "env-broken", null, null), issue(4, "resolve-failed", "figcraft", null), issue(5, "combination-failed", "figcraft", "0.18.2"), issue(6, "test-failed", "figcraft", "0.18.2")])!.number, 6);
  assert.equal(explaining("figcraft", "0.18.2", [issue(3, "env-broken", null, null), issue(4, "resolve-failed", "figcraft", null)])!.number, 4);
  assert.equal(explaining("figcraft", "0.18.2", [issue(3, "env-broken", null, null)])!.kind, "env-broken");
  // Another version, another repository, or a kind that holds nothing: found.
  for (const i of [issue(1, "test-failed", "figcraft", "0.18.3"), issue(2, "test-failed", "photocraft", "0.18.2"), issue(3, "downgrade", "figcraft", "0.18.2"),
    issue(4, "update-lag", "figcraft", "0.18.2"), issue(5, "incomplete-release", "figcraft", "0.18.2"), issue(6, "stable-behind", "figcraft", "0.18.2")]) {
    assert.equal(held([i]).state, "found", JSON.stringify(i));
  }
});

test("live: unavailable from the pin's marker, for its packages only, whatever else holds", () => {
  const pins = [pin("figcraft", "0.18.1", ["figcraft", "figcraft-server"], { unavailable: { since: "2026-11-12T08:00:00Z", issue: 40, packages: ["figcraft-server"] } })];
  const s = states(pins, health({ figcraft: "0.18.2" }), [], [issue(41, "test-failed", "figcraft", "0.18.2")])!;
  assert.deepEqual(s["figcraft-server"], { state: "unavailable", version: "0.18.1", reason: "upstream's files are gone", since: "2026-11-12T08:00:00.000Z", link: "https://github.com/o/r/issues/40" });
  assert.equal(s.figcraft.state, "held");
  const noIssue = states([pin("figcraft", "0.18.1", ["figcraft"], { unavailable: { since: "bad", issue: null, packages: ["figcraft"] } })], health({ figcraft: "0.18.1" }))!;
  assert.deepEqual(noIssue.figcraft, { state: "unavailable", version: "0.18.1", reason: "upstream's files are gone" });
});

test("live: waiting while upstream's newer release is incomplete", () => {
  const pins = [pin("materialcraft", "0.4.1")];
  const issues = [issue(43, "incomplete-release", "materialcraft", "0.4.2"), issue(44, "incomplete-release", "materialcraft", "0.4.1"), issue(45, "incomplete-release", "photocraft", "9.0.0")];
  assert.deepEqual(states(pins, health({ materialcraft: "0.4.1" }), [], issues)!.materialcraft,
    { state: "waiting", version: "0.4.2", reason: "upstream's release is incomplete", link: "https://github.com/o/r/issues/43" });
  assert.equal(incomplete("materialcraft", "0.4.2", issues), null, "only above main's version");
  // A newer eligible release found meanwhile is what's shown.
  assert.equal(states(pins, health({ materialcraft: "0.4.3" }), [], issues)!.materialcraft.state, "found");
});

test("live: a pulled pin, main following back: pulled, then testing, then held", () => {
  const pins = [pin("materialcraft", "0.4.1")];
  // Lower eligible, but the pin isn't confirmed pulled (it lost files, or an
  // earlier pin's sample): main stays, so it's current.
  assert.equal(states(pins, health({ materialcraft: "0.4.0" }))!.materialcraft.state, "current");
  assert.equal(states(pins, health({ materialcraft: ["0.4.0", undefined, { pinned: { tag: "v0.4.2", fingerprint: null, pulled: true } }] }))!.materialcraft.state, "current");
  const h = health({ materialcraft: ["0.4.0", undefined, { pinned: { tag: "v0.4.1", fingerprint: "x", pulled: true } }] });
  // Upstream's highest eligible is below the pulled pin: not current.
  assert.deepEqual(states(pins, h)!.materialcraft, { state: "pulled", version: "0.4.0", reason: PULLED, wait: "waiting for the next run",
    since: "2026-11-13T11:00:00.000Z", link: "https://github.com/storytold/materialcraft/releases/tag/v0.4.0" });
  // The downgrade under test.
  const runs: Run[] = [{ id: 7, created: "2026-11-13T11:30:00Z", inputs: [{ name: "materialcraft", version: "0.4.0" }] }];
  assert.deepEqual(states(pins, h, runs)!.materialcraft, { state: "testing", version: "0.4.0", since: "2026-11-13T11:30:00.000Z", link: "https://github.com/o/r/actions/runs/7" });
  // The downgrade failed: held, not hidden.
  assert.deepEqual(states(pins, h, [], [issue(50, "test-failed", "materialcraft", "0.4.0")])!.materialcraft,
    { state: "held", version: "0.4.0", reason: "tests failed", since: "2026-11-13T11:00:00.000Z", link: "https://github.com/o/r/issues/50" });
  // A downgrade issue holds nothing: still pulled.
  assert.equal(states(pins, h, [], [issue(51, "downgrade", "materialcraft", "0.4.1")])!.materialcraft.state, "pulled");
});

test("live: a pulled pin with no eligible release left stays, and says so", () => {
  const pins = [pin("artcraft", "0.41.1", ["artcraft-studio"])];
  const h = health({ artcraft: [null, undefined, { pinned: { tag: "artcraft-v0.41.1", fingerprint: "x", pulled: true } }] });
  assert.deepEqual(states(pins, h)!["artcraft-studio"], { state: "pulled", version: "0.41.1", stays: true, reason: PULLED_STAYS });
  // Not seen pulled: nothing eligible is just not checked.
  assert.equal(states(pins, health({ artcraft: null }))!["artcraft-studio"].state, "not-checked");
});

test("live: the stable snapshot's issues explain nothing about main's pin", () => {
  const pins = [pin("materialcraft", "0.4.1")];
  const h = health({ materialcraft: ["0.4.0", undefined, { pinned: { tag: "v0.4.1", fingerprint: "x", pulled: true } }] });
  const stableIssue = { ...issue(60, "resolve-failed", "materialcraft", null), channel: "stable" };
  assert.equal(states(pins, h, [], [stableIssue])!.materialcraft.state, "pulled");
  assert.equal(states(pins, h, [], [issue(61, "resolve-failed", "materialcraft", null)])!.materialcraft.state, "held");
});

test("live: an integrity issue for the record (no fingerprint) holds nothing", () => {
  const p = pin("photocraft", "0.23.1");
  const h = health({ photocraft: "0.23.1" });
  assert.deepEqual(states([p], h, [], [{ ...issue(70, "integrity", "photocraft", "0.23.1"), record: true }])!.photocraft, { state: "current" });
  assert.equal(states([p], h, [], [issue(71, "integrity", "photocraft", "0.23.1")])!.photocraft.state, "held");
  const marked = (meta: object) => `Text.\n\n<!-- artcraft-nix-issue ${JSON.stringify(meta)} -->\n`;
  assert.equal(metaOf(marked({ key: "integrity/photocraft/-", version: "0.23.1" }))!.record, true);
  assert.equal(metaOf(marked({ key: "integrity/photocraft/-", version: "0.23.1", fingerprint: "f" }))!.record, undefined);
});

test("live: an unavailable package links its open issue when the marker has no number yet", () => {
  const p = pin("pdfcraft", "0.21.1", ["pdfcraft", "pdfcraft-cli"], { unavailable: { since: "2026-11-13T10:00:00Z", issue: null, packages: ["pdfcraft-cli"] } } as any);
  const s = states([p], health({ pdfcraft: "0.21.1" }), [], [issue(44, "unavailable", "pdfcraft", "0.21.1")])!;
  assert.equal(s["pdfcraft-cli"].link, "https://github.com/o/r/issues/44");
});

test("live: a same-tag re-upload, tested or held, while upstream's version is main's", () => {
  const p = pin("photocraft", "0.23.1");
  const pins = [p];
  const h = health({ photocraft: "0.23.1" });
  const mine = pinFingerprint(sourceOf("photocraft"), p);
  const run = (fingerprint?: string): Run[] => [{ id: 8, created: "2026-11-13T11:40:00Z", inputs: [{ name: "photocraft", version: "0.23.1", ...(fingerprint ? { fingerprint } : {}) }] }];
  assert.deepEqual(states(pins, h, run("SHA256SUMS.txt=2:sha256:00"))!.photocraft,
    { state: "testing", version: "0.23.1", reason: SAME_TAG, since: "2026-11-13T11:40:00.000Z", link: "https://github.com/o/r/actions/runs/8" });
  // Main's own files (only a marker moves), or no fingerprint to tell: nothing to test.
  assert.deepEqual(states(pins, h, run(mine))!.photocraft, { state: "current" });
  assert.deepEqual(states(pins, h, run())!.photocraft, { state: "current" });
  // A hold on main's own version: the re-upload failed.
  assert.deepEqual(states(pins, h, [], [issue(52, "integrity", "photocraft", "0.23.1"), issue(53, "test-failed", "photocraft", "0.23.1")])!.photocraft,
    { state: "held", version: "0.23.1", reason: `tests failed (${SAME_TAG})`, since: "2026-11-13T11:00:00.000Z", link: "https://github.com/o/r/issues/53" });
  // Issues that hold nothing, or another version's, leave it current.
  assert.deepEqual(states(pins, h, [], [issue(54, "env-broken", null, null), issue(55, "resolve-failed", "photocraft", null), issue(56, "test-failed", "photocraft", "0.23.2")])!.photocraft, { state: "current" });
  // The run outranks the hold.
  assert.equal(states(pins, h, run("SHA256SUMS.txt=2:sha256:00"), [issue(53, "test-failed", "photocraft", "0.23.1")])!.photocraft.state, "testing");
  // The unavailable marker still wins for the package it names.
  const gone = pin("photocraft", "0.23.1", ["photocraft"], { unavailable: { since: "2026-11-13T10:00:00Z", issue: 40, packages: ["photocraft"] } });
  assert.equal(states([gone], h, run("SHA256SUMS.txt=2:sha256:00"))!.photocraft.state, "unavailable");
});

test("live: what a found version waits for, from the unfinished runs", () => {
  const run = (id: number, status: string, inputs: Run["inputs"] = []): Run => ({ id, created: "2026-11-13T11:00:00Z", status, inputs });
  assert.equal(waitFor([]), "waiting for the next run");
  assert.equal(waitFor([run(1, "in_progress")]), "run in progress");
  assert.equal(waitFor([run(1, "in_progress", [{ name: "x", version: "1.0.0" }])]), "not in this run");
  assert.equal(waitFor([run(1, "requested")]), "run starting");
  assert.equal(waitFor([run(1, "in_progress"), run(2, "pending")]), "queued for next run");
  assert.equal(waitFor([run(1, "pending", [{ name: "x", version: "1.0.0" }])]), "not in this run", "a run with a candidate has started");
});

test("reads: issue markers, validated", async () => {
  const body = (meta: object | string) => `Text.\n\n<!-- artcraft-nix-issue ${typeof meta === "string" ? meta : JSON.stringify(meta)} -->\n`;
  assert.deepEqual(metaOf(body({ kind: "test-failed", repo: "photocraft", version: "0.23.2", detail: "smoke", channel: null })), { kind: "test-failed", repo: "photocraft", version: "0.23.2", channel: null });
  assert.deepEqual(metaOf(body({ kind: "env-broken" })), { kind: "env-broken", repo: null, version: null, channel: null });
  // As scripts/ci/issues.ts writes it: a key.
  assert.deepEqual(metaOf(body({ clean: 0, detail: "x", key: "test-failed/figcraft/-", version: "0.18.2" })), { kind: "test-failed", repo: "figcraft", version: "0.18.2", channel: null });
  assert.deepEqual(metaOf(body({ key: "env-broken/-/-", version: null })), { kind: "env-broken", repo: null, version: null, channel: null });
  assert.deepEqual(metaOf(body({ key: "resolve-failed/pdfcraft/stable", version: "0.20.0" })), { kind: "resolve-failed", repo: "pdfcraft", version: "0.20.0", channel: "stable" });
  assert.equal(metaOf(body({ key: "test-failed/evil/-", version: "1.0.0" })), null);
  assert.deepEqual(metaOf(body({ kind: "no-match", repo: "pdfcraft", version: "v1", channel: null })), { kind: "no-match", repo: "pdfcraft", version: null, channel: null }, "a version that doesn't read is null");
  for (const bad of [body({ kind: "test-failed", repo: "evil" }), body({ kind: "<b>" }), body("{not json}"), "no marker", null]) assert.equal(metaOf(bad), null, String(bad));
  const pages: any[][] = [
    [...Array.from({ length: 99 }, (_, i) => ({ number: 100 + i, state: "open", body: "x" })), { number: 1, state: "open", body: body({ kind: "test-failed", repo: "figcraft", version: "0.18.2" }) }],
    [{ number: 2, state: "open", body: body({ kind: "unavailable", repo: "figcraft", version: "0.18.1" }), pull_request: {} }, { number: 3, state: "closed", body: body({ kind: "integrity" }) },
      { number: 4, state: "open", body: body({ kind: "stable-behind", repo: "lightcraft", version: "0.21.1" }) }],
  ];
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  };
  assert.deepEqual(await readIssues("o/r", "tok", f as any), [{ number: 1, kind: "test-failed", repo: "figcraft", version: "0.18.2", channel: null }, { number: 4, kind: "stable-behind", repo: "lightcraft", version: "0.21.1", channel: null }]);
  assert.equal(urls.length, 2, "a short page ends the listing");
  assert.ok(urls[0].startsWith("https://api.github.com/repos/o/r/issues?labels=artcraft-nix&state=open&per_page=100&page=1"));
  await assert.rejects(readIssues("o/r", "tok", (async () => new Response("", { status: 500 })) as any));
});

// A zip in memory: entries stored (0) or deflated (8), optionally a symlink,
// with knobs for every way an archive can lie about itself.
type Entry = { name: string; data: string; method?: number; symlink?: boolean; flags?: number; size?: number; localName?: string; localZero?: boolean; packedSize?: number };
function zip(entries: Entry[], o: { count?: number; commentLen?: number; disk?: number; trailing?: string; cdSizeDelta?: number } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data), method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name), localName = Buffer.from(e.localName ?? e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.localZero ? 0 : packed.length, 18); local.writeUInt32LE(e.localZero ? 0 : e.size ?? raw.length, 22); local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.symlink ? 0x0314 : 0x0014, 4); central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(e.packedSize ?? packed.length, 20); central.writeUInt32LE(e.size ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, localName, packed);
    centrals.push(central, name);
    offset += 30 + localName.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.disk ?? 0, 4);
  end.writeUInt16LE(o.count ?? entries.length, 8); end.writeUInt16LE(o.count ?? entries.length, 10);
  end.writeUInt32LE(cd.length + (o.cdSizeDelta ?? 0), 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(o.commentLen ?? 0, 20);
  return Buffer.concat([...locals, cd, end, Buffer.from(o.trailing ?? "")]);
}
const INPUTS = JSON.stringify({ base: "b", inputs: [{ name: "photocraft", files: [], from: "0.23.1", to: "0.23.2" }, { name: "nixpkgs", files: [], from: "a", to: "b" }] });

test("reads: only inputs.json, in memory, from a well-formed zip", () => {
  const pins = new Set(["photocraft", "vectorcraft"]);
  for (const method of [0, 8]) {
    const json = inputsJson(zip([{ name: "files/versions/photocraft.json", data: "{}" }, { name: "inputs.json", data: INPUTS, method }]));
    assert.deepEqual(candidateInputs(json!, pins), [{ name: "photocraft", version: "0.23.2" }], `method ${method}; nixpkgs isn't a repository`);
  }
  // Anything that could escape, or isn't plainly a member, voids the zip.
  for (const bad of [
    [{ name: "../x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "/etc/x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "a\\..\\x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "a\u0000b", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "files/../../x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: "../../scripts/status.ts", symlink: true }],
    [{ name: "link", data: "/", symlink: true }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, flags: 1 }],
    [{ name: "inputs.json", data: "x".repeat(MAX_MEMBER + 1) }],
    [{ name: "inputs.json", data: INPUTS, size: 3 }],
    [{ name: "other.json", data: INPUTS }],
    // A header that lies small: the real data is more, or inflates past the cap.
    [{ name: "inputs.json", data: INPUTS + " ".repeat(100), size: INPUTS.length }],
    [{ name: "inputs.json", data: " ".repeat(MAX_MEMBER * 4), size: 100 }],
    // ZIP64 markers, two inputs.json, a local header disguising its name.
    [{ name: "inputs.json", data: INPUTS, size: 0xffffffff }],
    [{ name: "inputs.json", data: INPUTS }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, localName: "../evil.txt" }],
    [{ name: "x", data: "a", localName: "../x" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, packedSize: 1 << 16 }],
  ] as Entry[][]) {
    assert.equal(inputsJson(zip(bad)), null, JSON.stringify(bad.map((e) => [e.name, e.localName, e.size])));
  }
  // The archive itself lying: entry counts, a comment that isn't there,
  // another disk, bytes after the end, cut short.
  const one = [{ name: "inputs.json", data: INPUTS }];
  // The unsafe entry comes last, where a count too low would hide it.
  const two = [{ name: "inputs.json", data: INPUTS }, { name: "files/../../x", data: "a" }];
  for (const [what, z] of [
    ["count too low hides an entry", zip(two, { count: 1 })],
    ["count too high", zip(one, { count: 2 })],
    ["comment length", zip(one, { commentLen: 5 })],
    ["multidisk", zip(one, { disk: 1 })],
    ["trailing bytes", zip(one, { trailing: "xx" })],
    ["directory size too large", zip(one, { cdSizeDelta: 4 })],
    ["directory size too small", zip(one, { cdSizeDelta: -4 })],
    ["truncated", zip(one).subarray(0, zip(one).length - 5)],
    ["truncated local header", Buffer.concat([zip(one).subarray(0, 10), zip(one).subarray(-22)])],
  ] as const) {
    assert.equal(inputsJson(z), null, what);
  }
  assert.equal(inputsJson(Buffer.from("not a zip at all, just bytes")), null);
  // Data descriptors (sizes only in the central entry), as upload-artifact
  // may write: fine.
  assert.deepEqual(candidateInputs(inputsJson(zip([{ name: "inputs.json", data: INPUTS, flags: 8, localZero: true }]))!, pins), [{ name: "photocraft", version: "0.23.2" }]);
  // A pin named twice can't say which version is tested: dropped.
  assert.deepEqual(candidateInputs(Buffer.from(JSON.stringify({ inputs: [{ name: "photocraft", to: "1.0.0" }, { name: "photocraft", to: "1.1.0" }, { name: "vectorcraft", to: "2.0.0" }] })), pins), [{ name: "vectorcraft", version: "2.0.0" }]);
  // Unknown pins and implausible versions are dropped; non-candidates are null.
  const odd = JSON.stringify({ inputs: [{ name: "evil", to: "1.0.0" }, { name: "photocraft", to: "1.1 <script>" }, { name: "vectorcraft", to: "2.0.0" }] });
  assert.deepEqual(candidateInputs(Buffer.from(odd), pins), [{ name: "vectorcraft", version: "2.0.0" }]);
  assert.equal(candidateInputs(Buffer.from("{"), pins), null);
  assert.equal(candidateInputs(Buffer.from("{}"), pins), null);  // The fingerprint comes along when it reads as one (a same-tag re-upload
  // is told from main's files by it); otherwise the input stays without it.
  const fp = "SHA256SUMS.txt=737932412:sha256:62,photocraft-0.23.1-linux-x86_64.tar.gz=-";
  const withFp = JSON.stringify({ inputs: [{ name: "photocraft", to: "0.23.1", fingerprint: fp }, { name: "vectorcraft", to: "2.0.0", fingerprint: "a=1:<b>" },
    { name: "filmcraft", to: "3.0.0", fingerprint: 7 }, { name: "lightcraft", to: "4.0.0", fingerprint: `a=${"1".repeat(9000)}` }] });
  assert.deepEqual(candidateInputs(Buffer.from(withFp), new Set(["photocraft", "vectorcraft", "filmcraft", "lightcraft"])),
    [{ name: "photocraft", version: "0.23.1", fingerprint: fp }, { name: "vectorcraft", version: "2.0.0" }, { name: "filmcraft", version: "3.0.0" }, { name: "lightcraft", version: "4.0.0" }]);
});

test("reads: a zip over the cap is refused, read or streamed", async () => {
  // Well formed but too big (a large stored member beside inputs.json).
  const big = zip([{ name: "big.bin", data: "x".repeat(MAX_ZIP), method: 0 }, { name: "inputs.json", data: INPUTS }]);
  assert.ok(big.length > MAX_ZIP);
  assert.ok(inputsJson(big) === null, "an oversized zip is refused");
  // A body with no content-length stops being read at the cap.
  let pulled = 0;
  const chunk = new Uint8Array(64 << 10);
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled += chunk.length; if (pulled > 8 * MAX_ZIP) c.close(); else c.enqueue(chunk); } });
  const read = await capped(new Response(body), MAX_ZIP);
  assert.ok(read === null, `got ${read?.length} bytes, not null`);
  assert.ok(pulled <= MAX_ZIP + 2 * chunk.length, `read ${pulled} bytes`);
  assert.equal((await capped(new Response("x".repeat(10)), 10))?.toString(), "x".repeat(10));
});

test("reads: unfinished runs on main, dry runs left out, one bad artifact ignored alone", async () => {
  const good = zip([{ name: "inputs.json", data: INPUTS }]);
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/runs?branch=main&status=in_progress")) {
      return json({ workflow_runs: [{ id: 1, created_at: "2026-11-13T11:00:00Z", display_title: "update" }, { id: 2, created_at: "x", display_title: "update (dry run)" }] });
    }
    if (url.includes("/runs?branch=main&status=queued")) {
      // The run's own status wins over the query's; one finished by now is left out.
      return json({ workflow_runs: [{ id: 3, created_at: "2026-11-13T11:30:00Z", display_title: "update", status: "pending" },
        { id: 6, created_at: "2026-11-13T11:31:00Z", display_title: "update", status: "completed" },
        // Run 7 was waiting at an earlier query (UNFINISHED's order) and has finished since.
        { id: 7, created_at: "2026-11-13T10:00:00Z", display_title: "update", status: "completed" }] });
    }
    if (url.includes("/runs?branch=main&status=waiting")) {
      return json({ workflow_runs: [{ id: 4, created_at: "2026-11-13T11:35:00Z", display_title: "update" }, { id: 5, created_at: "2026-11-13T11:36:00Z", display_title: "update" },
        { id: 7, created_at: "2026-11-13T10:00:00Z", display_title: "update" }] });
    }
    if (url.includes("/runs?")) return json({ workflow_runs: [] });
    if (url.endsWith("/runs/1/artifacts?name=candidate&per_page=100")) {
      return json({ artifacts: [{ id: 10, created_at: "2026-11-13T11:01:00Z", expired: false }, { id: 11, created_at: "2026-11-13T11:05:00Z", expired: false }] });
    }
    if (url.endsWith("/runs/3/artifacts?name=candidate&per_page=100")) return json({ artifacts: [{ id: 30, created_at: "2026-11-13T11:31:00Z", expired: false }] });
    if (url.endsWith("/runs/4/artifacts?name=candidate&per_page=100")) {
      // The newest has expired: the older one is read.
      return json({ artifacts: [{ id: 40, created_at: "2026-11-13T11:40:00Z", expired: false }, { id: 41, created_at: "2026-11-13T11:45:00Z", expired: true }] });
    }
    if (url.endsWith("/artifacts/41/zip")) throw new Error("an expired artifact was fetched");
    if (url.endsWith("/artifacts/40/zip")) return new Response(new Uint8Array(good), { status: 200 });
    if (url.endsWith("/runs/5/artifacts?name=candidate&per_page=100")) return json({ artifacts: [{ id: 50, created_at: "2026-11-13T11:50:00Z", expired: false }] });
    if (url.endsWith("/artifacts/50/zip")) return new Response(new Uint8Array(good), { status: 200, headers: { "content-length": String(MAX_ZIP + 1) } });
    if (url.endsWith("/artifacts/11/zip")) {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://storage.example/11" } });
    }
    if (url === "https://storage.example/11") {
      assert.equal((init?.headers as any)?.Authorization, undefined, "the token isn't sent to storage");
      return new Response(new Uint8Array(good), { status: 200 });
    }
    if (url.endsWith("/artifacts/30/zip")) return new Response(new Uint8Array(zip([{ name: "../x", data: "a" }, { name: "inputs.json", data: INPUTS }])), { status: 200 });
    return new Response("no", { status: 404 });
  };
  const warnings: string[] = [];
  // Nothing is written anywhere: run it in an empty folder and look.
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "status-reads-"));
  process.chdir(dir);
  let runs;
  try {
    runs = await readRuns("o/r", "tok", f as any, (m) => warnings.push(m));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(runs.sort((a, b) => a.id - b.id), [
    { id: 1, created: "2026-11-13T11:00:00Z", status: "in_progress", inputs: [{ name: "photocraft", version: "0.23.2" }] },
    { id: 3, created: "2026-11-13T11:30:00Z", status: "pending", inputs: [] },
    { id: 4, created: "2026-11-13T11:35:00Z", status: "waiting", inputs: [{ name: "photocraft", version: "0.23.2" }] },
    { id: 5, created: "2026-11-13T11:36:00Z", status: "waiting", inputs: [] },
  ]);
  assert.equal(warnings.length, 2, "run 3's unsafe zip and run 5's oversized download");
  assert.ok(!calls.some((u) => u.includes("/runs/2/")), "the dry run's artifacts aren't read");
  assert.ok(!calls.some((u) => u.includes("/runs/6/") || u.includes("/runs/7/")), "a run finished by now is left out, even one an earlier query had unfinished");
  for (const s of ["requested", "waiting", "pending", "queued", "in_progress"]) assert.ok(calls.some((u) => u.includes(`status=${s}`)), s);
  // Listing the runs failing ends the reads.
  await assert.rejects(readRuns("o/r", "tok", (async () => new Response("", { status: 500 })) as any));
});


