// Builds the status page's fixture sets from upstream's real releases, and
// the demo page from one of them:
//
//   node tests/fixtures/status-demo/make.ts [--upstream DIR]
//
// --upstream DIR reads `gh api repos/storytold/<repo>/releases` replies
// (DIR/<repo>.json) and keeps what the fixtures need in upstream.json here;
// without it, upstream.json is read as it is. Writes:
//
//   tests/fixtures/status-demo/{history,health,reads,meta}.json   the demo
//   tests/fixtures/status/{history,health,reads,meta}.json        the check's
//   docs/status-demo.html                                          the demo page
//
// What's real: every upstream version, tag, release time, asset ID and
// digest (from upstream.json), and main's pins today (versions/*.json and
// versions/stable/*.json). What's invented, and said so on the page: the
// history of main before today (a simulated watcher and update queue
// publishing each release as it came; commit times, queue times, release
// names), and the live scenario on 2026-11-22 (DEMO below).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { downloadUrl, fromRest, ineligible, MANIFEST, requiredAssets, SIGNATURE, SOURCES, sourceOf, versionOf, type Release } from "../../../shared/sources.ts";
import { readJson, ROOT, sri, type Pin } from "../../../scripts/lib/util.ts";
import { build, readFixtures } from "../../../scripts/status.ts";
import type { DemoInfo } from "../../../scripts/status-page.ts";

const HERE = join(ROOT, "tests", "fixtures", "status-demo");
const CHECK = join(ROOT, "tests", "fixtures", "status");
const REPO = "boltflake/artcraft-nix";

/** The demo's clock: when its live data was read. */
const NOW = "2026-11-22T14:05:00.000Z";
/** The simulated history starts here, with the releases out by then. */
const START = "2026-11-08T09:00:00.000Z";

// ---- upstream.json -------------------------------------------------------

/** What's kept of a release: enough for fromRest and the pins. */
function keep(repo: string, r: any) {
  const source = sourceOf(repo);
  const version = source && versionOf(source, r.tag_name);
  const wanted = new Set(version ? [...requiredAssets(source, version).map((a) => a.name), MANIFEST, SIGNATURE] : []);
  return {
    id: r.id, tag_name: r.tag_name, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at,
    assets: (r.assets ?? []).filter((a: any) => wanted.has(a.name)).map((a: any) => ({ name: a.name, id: a.id, digest: a.digest ?? null, state: a.state, size: a.size })),
  };
}

const { values } = parseArgs({ options: { upstream: { type: "string" } } });
if (values.upstream) {
  const out: Record<string, any[]> = {};
  for (const s of SOURCES) out[s.repo] = readJson(join(values.upstream, `${s.repo}.json`)).map((r: any) => keep(s.repo, r));
  writeFileSync(join(HERE, "upstream.json"), `${JSON.stringify(out, null, 1)}\n`);
}
const upstream: Record<string, any[]> = readJson(join(HERE, "upstream.json"));

// ---- Pins ----------------------------------------------------------------

const realPins = new Map<string, Pin>(SOURCES.map((s) => [s.repo, readJson(join(ROOT, "versions", `${s.repo}.json`)) as Pin]));
const realStable = new Map<string, Pin>(SOURCES.map((s) => [s.repo, readJson(join(ROOT, "versions", "stable", `${s.repo}.json`)) as Pin]));

/** A repository's eligible releases, oldest first. */
function eligible(repo: string): Release[] {
  const source = sourceOf(repo);
  return upstream[repo].map(fromRest).filter((r) => ineligible(source, r) === null && r.publishedAt)
    .sort((a, b) => Date.parse(a.publishedAt!) - Date.parse(b.publishedAt!));
}

/** The pin for a release: main's own file when it's main's version today,
 * otherwise built from the release's assets as pin.ts would write it. */
function pinOf(repo: string, r: Release): Pin {
  const source = sourceOf(repo);
  const version = versionOf(source, r.tag)!;
  const real = realPins.get(repo)!;
  if (real.version === version) return structuredClone(real);
  const by = new Map(r.assets.map((a) => [a.name, a]));
  const ref = (name: string) => ({ assetId: Number(by.get(name)!.id), digest: by.get(name)!.digest! });
  const packages: Pin["packages"] = {};
  for (const a of requiredAssets(source, version)) {
    const asset = by.get(a.name)!;
    (packages[a.pkg] ??= {})[a.system] = { url: downloadUrl(repo, r.tag, a.name), hash: sri(asset.digest!.slice(7)), assetId: Number(asset.id), digest: asset.digest! };
  }
  return { repo, version, tag: r.tag, releaseId: Number(r.id), manifest: ref(MANIFEST), signature: ref(SIGNATURE), packages, released: { at: new Date(r.publishedAt!).toISOString(), kind: "published" } };
}

// ---- The simulated history -------------------------------------------------

/** A number in [0, 1) from a string, the same every time. */
const rand = (key: string) => createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
const between = (key: string, lo: number, hi: number) => Math.round(lo + rand(key) * (hi - lo));
const iso = (ms: number) => new Date(ms).toISOString();

interface FixtureCommit { commit: string; at: string; message: string; files: Record<string, unknown> }

function history(repos: string[], behind: { repo: string; version: string } | null) {
  const made: { at: number; message: string; files: Record<string, unknown> }[] = [];
  const push = (at: number, message: string, files: Record<string, unknown>) => { made.push({ at, message, files }); };
  /** The commits in time order, each hash chained to its parent's. */
  const commits = (): FixtureCommit[] => {
    const out: FixtureCommit[] = [];
    for (const c of [...made].sort((a, b) => a.at - b.at)) {
      const commit = createHash("sha1").update(`${out.at(-1)?.commit ?? ""}\n${c.at}\n${c.message}\n${JSON.stringify(c.files)}`).digest("hex");
      out.push({ commit, at: iso(c.at), message: c.message, files: c.files });
    }
    return out;
  };
  // The first pins: each repository's newest eligible release by START.
  const start = Date.parse(START);
  const first: Record<string, unknown> = { "versions/nixpkgs-stable.json": readJson(join(ROOT, "versions", "nixpkgs-stable.json")) };
  const pending: { repo: string; release: Release; seen: number }[] = [];
  for (const repo of repos) {
    const list = eligible(repo);
    const before = list.filter((r) => Date.parse(r.publishedAt!) <= start);
    const initial = before.at(-1) ?? list[0];
    const pin = pinOf(repo, initial);
    const files = { [`versions/${repo}.json`]: pin, [`versions/stable/${repo}.json`]: pin };
    // A repository with no release yet is added by hand after its first.
    if (before.length) Object.assign(first, files);
    else push(Date.parse(initial.publishedAt!) + 3 * 3600e3, `Add ${repo}\n\nIts first release, pinned with pin.ts through branch CI.\n`, files);
    for (const r of list.filter((x) => Date.parse(x.publishedAt!) > Date.parse(initial.publishedAt!))) {
      // A release out before the hand commit that adds the repository is
      // seen once it lands.
      const at = Math.max(Date.parse(r.publishedAt!), before.length ? 0 : Date.parse(initial.publishedAt!) + 3 * 3600e3);
      pending.push({ repo, release: r, seen: at + between(`seen ${r.tag} ${repo}`, 20, 55) * 1000 });
    }
  }
  push(start, "Pin every repository\n\nThe first pins, through branch CI.", first);
  // The update queue: one run at a time, one waiting (the newest dispatch);
  // a run reads upstream when it starts and publishes everything it saw.
  pending.sort((a, b) => a.seen - b.seen);
  const names = new Map<string, number>();
  let free = start, i = 0;
  while (i < pending.length) {
    const dispatched = pending[i].seen;
    const startAt = Math.max(dispatched, free);
    // The newest dispatch before the run starts made the waiting run.
    let newest = dispatched;
    for (const p of pending) if (p.seen <= startAt && p.seen > newest) newest = p.seen;
    // A run behind another waited from its dispatch (the newest, which
    // replaced any older waiting one) to its start: at least a second.
    const waited = free > dispatched ? Math.max(1, Math.round((startAt - newest) / 1000)) : 0;
    const batch: typeof pending = [];
    while (i < pending.length && pending[i].seen <= startAt) batch.push(pending[i++]);
    // The newest release of each repository in the batch.
    const byRepo = new Map<string, (typeof pending)[number]>();
    for (const p of batch) byRepo.set(p.repo, p);
    const key = batch.map((p) => p.release.tag + p.repo).join();
    const queue = between(`queue ${key}`, 8, 45);
    const run = 40 + between(`tests ${key}`, 290, 350) + 15;
    const at = startAt + (queue + run) * 1000;
    free = at + 60_000; // issues and reconcile after publish
    const day = iso(at).slice(0, 10).replaceAll("-", ".");
    const n = (names.get(day) ?? 0) + 1;
    names.set(day, n);
    const files: Record<string, unknown> = {};
    const moved: string[] = [];
    for (const [repo, p] of [...byRepo].sort(([a], [b]) => SOURCES.findIndex((s) => s.repo === a) - SOURCES.findIndex((s) => s.repo === b))) {
      const pin = pinOf(repo, p.release);
      files[`versions/${repo}.json`] = pin;
      // The stable snapshot follows, except where the demo keeps it behind.
      if (!(behind && behind.repo === repo && behind.version === pin.version)) files[`versions/stable/${repo}.json`] = pin;
      moved.push(`${repo} ${pin.version}`);
    }
    push(at, `Update ${moved.join(", ")}\n\nArtcraft-Release: ${day}.${n}\nArtcraft-Queue: ${queue}\nArtcraft-Waited: ${waited}\n`, files);
  }
  return { commits, push };
}

// ---- The demo's live scenario --------------------------------------------

const DEMO_INVENTED = [
  "PhotoCraft 0.23.2 and VectorCraft 0.24.2 (being tested, and found), FigCraft 0.18.2 (held for a failed smoke) and MaterialCraft 0.4.2 (waiting, incomplete upstream) don't exist;",
  "the FigCraft server's files are not gone; CADCraft's watcher read didn't fail; NixOS stable isn't behind on LightCraft;",
  "and main's history before today is simulated: a watcher and update queue publishing each real release as it came, so every commit time, queue time, delivery and release name is made up.",
].join(" ");
const DEMO_REAL = "every upstream version and release time (GitHub's `publishedAt`, read on 22 Nov 2026), and main's pins on 22 Nov 2026 (all current).";
const SAMPLE = ["photocraft", "vectorcraft", "figcraft", "figcraft-server", "materialcraft", "cadcraft", "lightcraft"];

/** The live scenario. The check's set (demo false) adds what the demo
 * leaves out: a pulled pin (Studio: upstream's highest eligible below
 * main's), a same-tag re-upload under test (PdfCraft: main's version, other
 * files), an open stable-broken issue, and an unavailable marker the stable
 * snapshot hasn't taken. */
function scenario(repos: string[], h: ReturnType<typeof history>, demo: boolean) {
  const has = (r: string) => repos.includes(r);
  // FigCraft's server: its assets confirmed gone on 21 Nov (a publish with
  // no version change, so no release); in the demo, stable's copy too.
  if (has("figcraft")) {
    const pin = { ...realPins.get("figcraft")!, unavailable: { since: "2026-11-21T08:02:00.000Z", issue: 40, packages: ["figcraft-server"] } };
    h.push(Date.parse("2026-11-21T08:09:00Z"), "Mark figcraft-server unavailable\n\nIts pinned assets are gone upstream (#40).\n",
      { "versions/figcraft.json": pin, ...(demo ? { "versions/stable/figcraft.json": pin } : {}) });
  }
  // The watcher's state as /health returns it (watcher/src/watcher.ts).
  const read = (i: number) => iso(Date.parse(NOW) - (40 + i * 7) * 1000);
  const repoStates: Record<string, unknown> = {};
  repos.forEach((repo, i) => {
    const main = realPins.get(repo)!;
    const override: Record<string, [string, string]> = {
      photocraft: ["0.23.2", "2026-11-22T13:51:40.000Z"],
      vectorcraft: ["0.24.2", "2026-11-22T13:58:10.000Z"],
      figcraft: ["0.18.2", "2026-11-22T09:12:05.000Z"],
      ...(demo ? {} : { artcraft: ["0.41.0", "2026-11-22T12:30:00.000Z"] as [string, string] }),
    };
    const [version, firstSeen] = override[repo] ?? [main.version, main.released!.at];
    const tag = `${sourceOf(repo).prefix}${version}`;
    repoStates[repo] = {
      // Studio's pin seen pulled (a prerelease again) in the check's set.
      pinned: { tag: main.tag, fingerprint: "sample", pulled: !demo && repo === "artcraft" },
      eligible: { tag, version, fingerprint: "sample", firstSeen },
      waiting: repo === "materialcraft" ? { "v0.4.2": { firstSeen: "2026-11-22T11:40:12.000Z" } } : {},
      read: read(i),
      ...(repo === "cadcraft" ? { error: { kind: "http", message: "HTTP 502", since: "2026-11-22T13:31:00.000Z" } } : {}),
    };
  });
  const keys = { deployed: "sample", state: { repos: repoStates, pins: { oid: null, tags: {} }, poll: {}, dispatch: { pending: false }, deployed: "sample", written: iso(Date.parse(NOW) - 25_000) } };
  const runs = [
    ...(has("photocraft") ? [{ id: 19_663_004_211, created: "2026-11-22T13:52:02Z", status: "in_progress", inputs: [{ name: "photocraft", version: "0.23.2" }] }] : []),
    ...(has("vectorcraft") ? [{ id: 19_663_201_877, created: "2026-11-22T13:58:31Z", status: "pending", inputs: [] }] : []),
    ...(!demo && has("pdfcraft") ? [{ id: 19_663_004_377, created: "2026-11-22T13:58:10Z", status: "in_progress",
      inputs: [{ name: "pdfcraft", version: realPins.get("pdfcraft")!.version, fingerprint: `SHA256SUMS.txt=900000001:sha256:${"0".repeat(63)}1` }] }] : []),
  ];
  const issues = [
    ...(has("figcraft") ? [{ number: 40, kind: "unavailable", repo: "figcraft", version: "0.18.1" }, { number: 41, kind: "test-failed", repo: "figcraft", version: "0.18.2" }] : []),
    ...(has("materialcraft") ? [{ number: 43, kind: "incomplete-release", repo: "materialcraft", version: "0.4.2" }] : []),
    ...(has("lightcraft") ? [{ number: 44, kind: "stable-behind", repo: "lightcraft", version: "0.21.1" }] : []),
    ...(demo ? [] : [{ number: 46, kind: "stable-broken", repo: null, version: null }]),
  ];
  return { health: keys, reads: { runs, issues } };
}

function write(dir: string, repos: string[], demo: boolean) {
  mkdirSync(dir, { recursive: true });
  const behind = repos.includes("lightcraft") ? { repo: "lightcraft", version: realPins.get("lightcraft")!.version } : null;
  const h = history(repos, behind);
  const { health, reads } = scenario(repos, h, demo);
  // The tip's stable snapshot is today's real one, but for the app kept behind.
  for (const repo of repos) if (repo !== behind?.repo && JSON.stringify(realStable.get(repo)) !== JSON.stringify(realPins.get(repo))) throw new Error(`${repo}: stable differs today`);
  const meta: Record<string, unknown> = { now: NOW, repo: REPO };
  if (demo) meta.demo = { now: NOW, real: DEMO_REAL, invented: DEMO_INVENTED, sample: SAMPLE } satisfies DemoInfo;
  const json = (name: string, v: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(v, null, 1)}\n`);
  json("history.json", { commits: h.commits() });
  json("health.json", health);
  json("reads.json", reads);
  json("meta.json", meta);
}

const ALL = SOURCES.map((s) => s.repo);
write(HERE, ALL, true);
write(CHECK, ["photocraft", "pdfcraft", "figcraft", "lightcraft", "materialcraft", "artcraft"], false);
for (const f of readdirSync(CHECK)) if (f.endsWith(".tmp")) rmSync(join(CHECK, f));

// The demo page.
const site = mkdtempSync(join(tmpdir(), "status-demo-"));
const f = readFixtures(HERE);
build(site, f.history, f.repo, f.reads, f.now, f.demo);
copyFileSync(join(site, "index.html"), join(ROOT, "docs", "status-demo.html"));
rmSync(site, { recursive: true, force: true });
console.log(`wrote ${HERE}, ${CHECK} and docs/status-demo.html (${readFileSync(join(ROOT, "docs", "status-demo.html")).length} bytes)`);
