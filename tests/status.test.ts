// The status page's data (scripts/status.ts): main's history of the pins,
// from git and from fixtures, the stays and deliveries, the speed figures,
// NixOS stable, badges, the digest, the deploy rule and the offline build.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { badge, build, dataId, decide, fixtureHistory, gitHistory, medianDelivery, readFixtures, rows, stableView, stays, TARGET_S, trailersOf, type History } from "../scripts/status.ts";
import type { Pin } from "../scripts/lib/util.ts";
import { CATEGORIES, PACKAGE_ORDER, TITLES } from "../scripts/lib/titles.ts";
import { SOURCES } from "../shared/sources.ts";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "status");
const DEMO = join(ROOT, "tests", "fixtures", "status-demo");
// Scratch commits never read the machine's git config (signing, hooks).
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });

const asset = (v: string) => ({ url: `https://x/${v}`, hash: "h", assetId: 1, digest: `sha256:${v}` });
const pin = (repo: string, version: string, extra: Partial<Pin> = {}, pkgs = [repo]): Pin => ({
  repo, version, tag: `v${version}`, releaseId: 1, manifest: { assetId: 1, digest: "d" }, signature: { assetId: 1, digest: "d" },
  packages: Object.fromEntries(pkgs.map((p) => [p, { "x86_64-linux": asset(version), "aarch64-linux": asset(version) }])), ...extra });
const rel = (at: string, kind: "published" | "seen" = "published") => ({ released: { at, kind } });
type C = { at: string; message?: string; files: Record<string, unknown> };
let n = 0;
const hist = (commits: C[]): History => fixtureHistory({ commits: commits.map((c) => ({ commit: (++n).toString(16).padStart(40, "0"), message: "m", ...c })) });
const trailer = (release: string, queue = 30, waited = 0) => `Update\n\nArtcraft-Release: ${release}\nArtcraft-Queue: ${queue}\nArtcraft-Waited: ${waited}\n`;

test("titles: every package of every repository once, by category, companions after their app", () => {
  const all = SOURCES.flatMap((s) => Object.keys(s.packages));
  assert.deepEqual(Object.keys(TITLES).sort(), all.slice().sort());
  assert.deepEqual(PACKAGE_ORDER.slice().sort(), all.slice().sort(), "each package exactly once");
  assert.deepEqual(PACKAGE_ORDER.slice(16, 18), ["pdfcraft", "pdfcraft-cli"]);
  assert.deepEqual(PACKAGE_ORDER.slice(10, 12), ["figcraft", "figcraft-server"]);
  for (const [pkg, t] of Object.entries(TITLES)) if (t.companionOf) assert.ok(SOURCES.find((s) => s.repo === t.companionOf)!.packages[pkg], pkg);
  const apps = CATEGORIES.flatMap((c) => c.apps);
  assert.deepEqual(apps.slice().sort(), all.filter((n) => !TITLES[n].companionOf).sort(), "every app in one category; no companion in any");
});

test("titles: the README's package tables are the categories, in order", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const part = readme.slice(readme.indexOf("\n## Packages\n"), readme.indexOf("\n## ", readme.indexOf("\n## Packages\n") + 1));
  const tables = part.split(/\n### /).slice(1).map((s) => ({
    title: s.slice(0, s.indexOf("\n")),
    names: [...s.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]),
  }));
  const apps = tables.filter((t) => !["Companion tools (headless)", "Bundles and helpers"].includes(t.title));
  assert.deepEqual(apps, CATEGORIES.map((c) => ({ title: c.title, names: c.apps })));
  assert.equal(tables.length, CATEGORIES.length + 2, "the companions' and helpers' tables too, nothing else");
});

test("trailers: the release name, queue and wait, from the last paragraph only", () => {
  assert.deepEqual(trailersOf(trailer("2026.11.12.3", 37, 0)), { release: "2026.11.12.3", queue: 37, waited: 0 });
  assert.deepEqual(trailersOf("Artcraft-Release: 2026.11.12.3\n\nBody text."), { release: null, queue: null, waited: null }, "not in the last paragraph");
  assert.deepEqual(trailersOf("x\n\nArtcraft-Release: 2026.11.12.0\nArtcraft-Queue: -5\nArtcraft-Waited: soon"), { release: null, queue: null, waited: null });
  assert.deepEqual(trailersOf("x\n\nartcraft-release:2026.11.02.12\n"), { release: "2026.11.02.12", queue: null, waited: null }, "keys are case-blind");
  assert.deepEqual(trailersOf("Hand re-pin of photocraft"), { release: null, queue: null, waited: null });
});

test("history: stays per package, re-pins, returns, older versions, a companion added later, and release names", () => {
  const h = hist([
    { at: "2026-11-01T00:00:00Z", files: { "versions/pdfcraft.json": pin("pdfcraft", "1.0.0") } },
    // A same-tag re-pin (new digests, same version): the same stay.
    { at: "2026-11-02T00:00:00Z", files: { "versions/pdfcraft.json": pin("pdfcraft", "1.0.0", { releaseId: 2 }) } },
    { at: "2026-11-03T00:00:00Z", message: trailer("2026.11.03.1"), files: { "versions/pdfcraft.json": pin("pdfcraft", "1.1.0", rel("2026-11-02T23:52:00Z"), ["pdfcraft", "pdfcraft-cli"]) } },
    { at: "2026-11-04T00:00:00Z", files: { "versions/pdfcraft.json": pin("pdfcraft", "1.0.0", {}, ["pdfcraft", "pdfcraft-cli"]) } },
    { at: "2026-11-05T00:00:00Z", message: trailer("2026.11.05.1"), files: { "versions/pdfcraft.json": pin("pdfcraft", "1.1.0", rel("2026-11-02T23:52:00Z"), ["pdfcraft", "pdfcraft-cli"]) } },
    { at: "2026-11-06T00:00:00Z", message: trailer("2026.11.06.1"), files: { "versions/pdfcraft.json": pin("pdfcraft", "1.2.0", rel("2026-11-05T23:50:00Z"), ["pdfcraft", "pdfcraft-cli"]) } },
  ]);
  const all = stays(h);
  assert.deepEqual(all.get("pdfcraft")!.map((s) => [s.version, s.counted, s.published.release]),
    [["1.0.0", "added", null], ["1.1.0", true, "2026.11.03.1"], ["1.0.0", "returned", null], ["1.1.0", "returned", "2026.11.05.1"], ["1.2.0", true, "2026.11.06.1"]]);
  assert.deepEqual(all.get("pdfcraft-cli")!.map((s) => [s.version, s.counted]), [["1.1.0", "added"], ["1.0.0", "older"], ["1.1.0", "returned"], ["1.2.0", true]]);
  const [app, cli] = rows(h, all);
  assert.equal(app.gap, 600);
  assert.deepEqual(app.history.map((d) => [d.version, d.gap, d.published.release]), [["1.2.0", 600, "2026.11.06.1"], ["1.1.0", 480, "2026.11.03.1"]]);
  assert.equal(app.notes, "https://github.com/storytold/pdfcraft/releases/tag/v1.2.0");
  assert.equal(cli.name, "pdfcraft-cli");
  assert.equal(cli.repo, "pdfcraft");
});

test("history: a release time that is approximate, unknown or after the publish", () => {
  const h = hist([
    { at: "2026-11-01T00:00:00Z", files: Object.fromEntries(["photocraft", "vectorcraft", "filmcraft", "lightcraft"].map((r) => [`versions/${r}.json`, pin(r, "1.0.0")])) },
    { at: "2026-11-02T12:00:00Z", files: {
      "versions/photocraft.json": pin("photocraft", "1.1.0", rel("2026-11-02T11:00:00Z", "seen")),
      "versions/vectorcraft.json": pin("vectorcraft", "1.1.0", rel("2026-11-02T12:00:00.400Z")),
      "versions/filmcraft.json": pin("filmcraft", "1.1.0", { released: { at: "x", kind: "published" } }),
      "versions/lightcraft.json": pin("lightcraft", "1.1.0", { released: { at: "2026-11-02T11:00:00Z", kind: "announced" as any } }),
    } },
  ]);
  const by = Object.fromEntries(rows(h).map((r) => [r.name, r]));
  assert.deepEqual([by.photocraft.gap, badge(by.photocraft).color], [3600, "blue"]);
  for (const r of ["vectorcraft", "filmcraft", "lightcraft"]) assert.deepEqual([by[r].gap, by[r].released, badge(by[r]).color], [null, null, "lightgrey"], r);
});

test("history: NixOS stable's copies and nixpkgs-stable are never main's, but are in the tree", () => {
  const h = hist([{ at: "2026-11-01T00:00:00Z", files: { "versions/photocraft.json": pin("photocraft", "1.0.0"), "versions/stable/photocraft.json": pin("photocraft", "0.9.0"),
    "versions/nixpkgs-stable.json": { name: "nixpkgs-stable", channel: "nixos-26.05" } } }]);
  assert.deepEqual([...stays(h).keys()], ["photocraft"]);
  assert.equal(h.tree.size, 3);
  assert.deepEqual(stableView(h), { channel: "nixos-26.05", current: false, differing: [{ name: "photocraft", stable: "0.9.0", main: "1.0.0" }], unavailable: [], issue: null, broken: null, builds: null });
});

test("stable: current, a newer build, a missing package, unavailable there, and its issues", () => {
  const fig = pin("figcraft", "0.18.1", {}, ["figcraft", "figcraft-server"]);
  const h = hist([{ at: "2026-11-01T00:00:00Z", files: {
    "versions/photocraft.json": pin("photocraft", "1.0.0"), "versions/stable/photocraft.json": pin("photocraft", "1.0.0"),
    "versions/lightcraft.json": pin("lightcraft", "1.0.0"), "versions/stable/lightcraft.json": { ...pin("lightcraft", "1.0.0"), packages: { lightcraft: { "x86_64-linux": asset("old") } } },
    "versions/figcraft.json": fig, "versions/stable/figcraft.json": { ...pin("figcraft", "0.18.1", { unavailable: { since: "s", issue: 1, packages: ["figcraft"] } }) },
  } }]);
  const v = stableView(h, [{ number: 9, kind: "stable-broken", repo: null, version: null }, { number: 7, kind: "stable-behind", repo: "lightcraft", version: "1.0.0" }]);
  // FigCraft: the same files, but only the snapshot marks it unavailable.
  assert.deepEqual(v.differing, [{ name: "figcraft", stable: "0.18.1", main: "0.18.1", marker: "stable" }, { name: "figcraft-server", stable: null, main: "0.18.1" },
    { name: "lightcraft", stable: "1.0.0", main: "1.0.0" }]);
  assert.deepEqual([v.current, v.unavailable, v.issue, v.broken, v.builds], [false, ["figcraft"], 7, 9, "broken"]);
});

test("stable: the snapshot's freshness and its builds are separate", () => {
  const files = { "versions/photocraft.json": pin("photocraft", "1.0.0"), "versions/stable/photocraft.json": pin("photocraft", "1.0.0") };
  const h = hist([{ at: "2026-11-01T00:00:00Z", files }]);
  const broken = [{ number: 9, kind: "stable-broken", repo: null, version: null }];
  // Up to date and broken at once; up to date and passing; nothing known without the reads.
  assert.deepEqual([stableView(h, broken).current, stableView(h, broken).builds, stableView(h, broken).broken], [true, "broken", 9]);
  assert.deepEqual([stableView(h, []).current, stableView(h, []).builds], [true, "ok"]);
  assert.deepEqual([stableView(h).current, stableView(h).builds], [true, null]);
  // A marker on main the snapshot hasn't taken yet: behind, though versions and files agree.
  const marked = pin("photocraft", "1.0.0", { unavailable: { since: "s", issue: 3, packages: ["photocraft"] } });
  const m = stableView(hist([{ at: "2026-11-01T00:00:00Z", files: { ...files, "versions/photocraft.json": marked } }]), []);
  assert.deepEqual([m.current, m.differing, m.unavailable, m.builds], [false, [{ name: "photocraft", stable: "1.0.0", main: "1.0.0", marker: "main" }], [], "ok"]);
});

test("median: per release, the target without queue time and runs ahead, the window, and fewer than five", () => {
  const commits: C[] = [{ at: "2026-10-01T00:00:00Z", files: Object.fromEntries(["photocraft", "pdfcraft"].map((r) => [`versions/${r}.json`, pin(r, "1.0.0", {}, r === "pdfcraft" ? ["pdfcraft", "pdfcraft-cli"] : [r])])) }];
  // Six releases of photocraft: 7 min each, 1 min of it queueing; two had a run ahead (15 min).
  for (let i = 1; i <= 6; i++) {
    const at = Date.parse("2026-11-01T00:00:00Z") + i * 86400e3;
    const ahead = i > 4;
    commits.push({ at: new Date(at).toISOString(), message: trailer(`2026.11.0${i + 1}.1`, 60, ahead ? 300 : 0),
      files: { "versions/photocraft.json": pin("photocraft", `1.${i}.0`, rel(new Date(at - (ahead ? 900 : 420) * 1000).toISOString())) } });
  }
  // PdfCraft and its CLI: one release, counted once; a hand commit (no trailers) only in "all".
  commits.push({ at: "2026-11-08T00:00:00Z", files: { "versions/pdfcraft.json": pin("pdfcraft", "1.1.0", rel("2026-11-07T23:50:00Z"), ["pdfcraft", "pdfcraft-cli"]) } });
  const d = medianDelivery(stays(hist(commits)))!;
  assert.equal(d.target, null, "too few for the target: 4");
  assert.deepEqual(d.all, { median: 420, count: 7 }, "all: 7 releases, the app and its companion once");
  assert.equal(d.until, "2026-11-08T00:00:00.000Z");
  // A fifth run with none ahead brings the target in.
  commits.push({ at: "2026-11-09T00:00:00Z", message: trailer("2026.11.09.1", 30, 0), files: { "versions/photocraft.json": pin("photocraft", "1.9.0", rel("2026-11-08T23:52:00Z")) } });
  const e = medianDelivery(stays(hist(commits)))!;
  assert.deepEqual(e.target, { median: 360, count: 5 });
  assert.ok(e.target!.median < TARGET_S);
  // Releases older than 30 days before the newest stay start are out.
  commits.push({ at: "2026-12-30T00:00:00Z", files: { "versions/photocraft.json": pin("photocraft", "2.0.0") } });
  assert.equal(medianDelivery(stays(hist(commits))), null);
});

test("median: the target is moved-at - publishedAt - Queue where Waited is 0, a missing trailer leaves the release out; all is moved-at - publishedAt", () => {
  const commits: C[] = [{ at: "2026-10-01T00:00:00Z", files: { "versions/photocraft.json": pin("photocraft", "1.0.0") } }];
  let day = 0;
  const add = (gap: number, message: string) => {
    const at = Date.parse("2026-11-01T00:00:00Z") + ++day * 86400e3;
    commits.push({ at: new Date(at).toISOString(), message, files: { "versions/photocraft.json": pin("photocraft", `1.${day}.0`, rel(new Date(at - gap * 1000).toISOString())) } });
  };
  // Five counted: gaps 400..800 s, Queue 100 s, Waited 0: targets 300..700.
  for (const gap of [400, 500, 600, 700, 800]) add(gap, trailer(`2026.11.${String(day + 2).padStart(2, "0")}.1`, 100, 0));
  // Left out of the target, each of them in "all": Queue missing, Waited missing, a run ahead, a hand commit.
  add(60, "Update\n\nArtcraft-Release: 2026.11.20.1\nArtcraft-Waited: 0\n");
  add(70, "Update\n\nArtcraft-Release: 2026.11.21.1\nArtcraft-Queue: 10\n");
  add(80, trailer("2026.11.22.1", 10, 45));
  add(90, "A hand commit");
  const d = medianDelivery(stays(hist(commits)))!;
  assert.deepEqual(d.target, { median: 500, count: 5 });
  assert.deepEqual(d.all, { median: 400, count: 9 }, "60, 70, 80, 90, 400, 500, 600, 700, 800");
  // Queue time larger than the gap counts as no time, never negative.
  add(50, trailer("2026.11.23.1", 500, 0));
  assert.deepEqual(medianDelivery(stays(hist(commits)))!.target, { median: 450, count: 6 }, "0, 300, 400, 500, 600, 700");
});

test("badges: colour by delivery, grey when not a delivery, red when unavailable", () => {
  const h = hist([
    { at: "2026-11-01T00:00:00Z", files: { "versions/figcraft.json": pin("figcraft", "0.18.0", {}, ["figcraft", "figcraft-server"]) } },
    { at: "2026-11-02T12:00:00Z", files: { "versions/figcraft.json": pin("figcraft", "0.18.1", { ...rel("2026-11-02T08:00:00Z"), unavailable: { since: "2026-11-03T00:00:00Z", issue: 40, packages: ["figcraft-server"] } }, ["figcraft", "figcraft-server"]) } },
  ]);
  const [app, server] = rows(h);
  assert.deepEqual(badge(app), { schemaVersion: 1, label: "figcraft", message: "0.18.1", color: "yellow" });
  assert.deepEqual(badge(server), { schemaVersion: 1, label: "figcraft-server", message: "0.18.1 unavailable", color: "red" });
  assert.deepEqual(server.unavailable, { since: "2026-11-03T00:00:00Z", issue: 40 });
  const added = rows(hist([{ at: "2026-11-01T00:00:00Z", files: { "versions/photocraft.json": pin("photocraft", "1.0.0", rel("2026-10-31T23:59:00Z")) } }]))[0];
  assert.equal(badge(added).color, "lightgrey");
});

/** A scratch git repository holding a fixture's history, commit by commit. */
function repoFrom(dir: string, data: any): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const c of data.commits) {
    for (const [path, value] of Object.entries<any>(c.files)) {
      const file = join(dir, path);
      if (value === null) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    const env = { ...process.env, GIT_COMMITTER_DATE: c.at, GIT_AUTHOR_DATE: c.at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["-C", dir, "add", "-A"], { env });
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", c.message], { env });
  }
}

test("history: git and the fixtures read the same history, trailers and tree", () => {
  const data = JSON.parse(readFileSync(join(FIXTURES, "history.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "status-git-"));
  const cwd = process.cwd();
  try {
    repoFrom(dir, data);
    process.chdir(dir);
    const fromGit = gitHistory("HEAD"), fromFixture = fixtureHistory(data);
    const strip = (h: History) => ({ rows: rows(h).map((r) => ({ ...r, published: r.published && { ...r.published, commit: "" }, history: r.history.map((d) => ({ ...d, published: { ...d.published, commit: "" } })) })),
      stable: stableView(h), median: medianDelivery(stays(h)) });
    assert.deepEqual(strip(fromGit), strip(fromFixture));
    assert.deepEqual([...fromGit.tree.keys()].sort(), [...fromFixture.tree.keys()].sort());
    assert.equal(fromGit.commits.length, fromFixture.commits.length);
    assert.ok(fromGit.commits.some((c) => c.trailers.release && c.trailers.queue !== null && c.trailers.waited !== null), "trailers read from git");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build: deterministic, every file in the digest, live.json the page's id and check time", () => {
  const f = readFixtures(FIXTURES);
  const a = mkdtempSync(join(tmpdir(), "status-a-")), b = mkdtempSync(join(tmpdir(), "status-b-"));
  try {
    const ra = build(a, f.history, f.repo, f.reads, f.now), rb = build(b, f.history, f.repo, f.reads, f.now);
    assert.equal(ra.digest, rb.digest);
    assert.ok(ra.live);
    for (const file of ["index.html", "status.json", "live.json"]) assert.equal(readFileSync(join(a, file), "utf8"), readFileSync(join(b, file), "utf8"), file);
    const status = JSON.parse(readFileSync(join(a, "status.json"), "utf8"));
    const liveJson = JSON.parse(readFileSync(join(a, "live.json"), "utf8"));
    assert.deepEqual(liveJson, { id: status.id, checked: status.live.checked });
    const { digest: _d, ...rest } = status;
    assert.equal(dataId(rest), status.id);
    assert.ok(readFileSync(join(a, "index.html"), "utf8").includes(`data-id="${status.id}"`));
    const badges = readdirSync(join(a, "badges")).sort();
    assert.deepEqual(badges, status.packages.map((r: any) => `${r.name}.json`).sort());
    // A badge of a package that's gone doesn't survive a rebuild in place.
    writeFileSync(join(a, "badges", "gone.json"), "{}");
    build(a, f.history, f.repo, f.reads, f.now);
    assert.ok(!existsSync(join(a, "badges", "gone.json")));
    // Only the check time moved: the same id.
    const later = { ...f.reads!, health: JSON.parse(JSON.stringify(f.reads!.health).replace(/"(read|written)":"2026-11-22T1[34]:\d\d/g, '"$1":"2026-11-22T14:15')) };
    build(b, f.history, f.repo, later, new Date("2026-11-22T14:20:00Z"));
    const moved = JSON.parse(readFileSync(join(b, "status.json"), "utf8"));
    assert.equal(moved.id, status.id);
    assert.notEqual(moved.live.checked, status.live.checked);
    assert.notEqual(moved.digest, status.digest);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("decide: deploy on change; a failed live read deploys only when git-derived data changed", () => {
  const built = { digest: "d1", packages: [{ name: "x" }] as any, stable: { current: true, differing: [], unavailable: [] } as any, delivery: null };
  assert.deepEqual(decide(built, null, false), { deploy: true, fail: false });
  assert.deepEqual(decide(built, { ...built }, false), { deploy: false, fail: false });
  assert.deepEqual(decide(built, { ...built, digest: "d0" }, false), { deploy: true, fail: false });
  assert.deepEqual(decide(built, { ...built, digest: "d0", live: { checked: "x" } }, true), { deploy: false, fail: true });
  assert.deepEqual(decide(built, { ...built, digest: "d0", packages: [{ name: "y" }] }, true), { deploy: true, fail: false });
  // The stable channel and markers are git's too: a change deploys despite the failed reads.
  const stable = { channel: "nixos-26.05", current: true, differing: [], unavailable: [], issue: null, broken: null, builds: null };
  const withStable = { ...built, stable };
  assert.deepEqual(decide(withStable, { ...withStable, digest: "d0", stable: { ...stable, channel: "nixos-25.11" } }, true), { deploy: true, fail: false });
  assert.deepEqual(decide(withStable, { ...withStable, digest: "d0", stable: { ...stable, current: false, differing: [{ name: "x", stable: "1", main: "1", marker: "main" }] } }, true), { deploy: true, fail: false });
  // Its issue numbers and build state come from the reads: an outage alone can't deploy them.
  assert.deepEqual(decide(withStable, { ...withStable, digest: "d0", stable: { ...stable, broken: 9, builds: "broken" } }, true), { deploy: false, fail: true });
});

test("the offline build: status-page.ts and status.ts write the site from fixtures, with no network", () => {
  for (const script of ["scripts/status-page.ts", "scripts/status.ts"]) {
    const out = mkdtempSync(join(tmpdir(), "status-cli-"));
    try {
      const said = JSON.parse(execFileSync(process.execPath, [join(ROOT, script), "--fixtures", FIXTURES, "--out", out], { encoding: "utf8" }));
      assert.deepEqual([said.live, said.error], [true, null], script);
      for (const f of ["index.html", "status.json", "live.json", "badges/photocraft.json", "badges/figcraft-server.json", "badges/pdfcraft-cli.json"]) assert.ok(existsSync(join(out, f)), `${script}: ${f}`);
      const page = readFileSync(join(out, "index.html"), "utf8");
      assert.ok(page.includes("PhotoCraft") && !page.includes('class="demo"'));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("fixtures: the check's covers every state; the demo is marked, and docs/status-demo.html is its page", () => {
  const f = readFixtures(FIXTURES);
  const out = mkdtempSync(join(tmpdir(), "status-fx-"));
  try {
    build(out, f.history, f.repo, f.reads, f.now);
    const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
    assert.deepEqual([...new Set(Object.values<any>(status.live.states).map((s) => s.state))].sort(), ["current", "held", "pulled", "testing", "unavailable", "waiting"]);
    assert.equal(status.live.states.pdfcraft.reason, "same version, new files");
    assert.equal(status.stable.current, false);
    assert.equal(status.stable.builds, "broken");
    assert.ok(status.delivery.all);
    const d = readFixtures(DEMO);
    assert.ok(d.demo && d.demo.sample.length > 0);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    build(out, d.history, d.repo, d.reads, d.now, d.demo);
    const demoStatus = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
    assert.deepEqual([...new Set(Object.values<any>(demoStatus.live.states).map((s) => s.state))].sort(), ["current", "found", "held", "not-checked", "testing", "unavailable", "waiting"]);
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), readFileSync(join(ROOT, "docs", "status-demo.html"), "utf8"), "regenerate with node tests/fixtures/status-demo/make.ts");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
