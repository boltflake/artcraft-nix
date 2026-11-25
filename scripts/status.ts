// The status page (pages.yml): for every package on `main`, its version,
// when upstream released it, when artcraft-nix published it (and in which
// of this repo's releases), and the gap between the two; plus a shields.io
// endpoint badge per package, and, with the live reads, each package's
// state (status-live.ts). The page itself is status-page.ts. As in
// t3code-nix, with packages from repository pins (versions/<repo>.json).
//
//   node scripts/status.ts OUT_DIR [REF] [--health FILE --reads FILE] [--site FILE]
//   node scripts/status.ts --fixtures DIR --out OUT_DIR
//
// The first reads the pins and their history at REF (default HEAD) from
// git, and the watcher's /health reply and the live job's reads
// (status-reads.ts) when given. The second reads all of that from fixture
// files, with no git and no network (see readFixtures). Both write
// OUT_DIR/index.html, OUT_DIR/status.json, OUT_DIR/live.json,
// OUT_DIR/social-card.png (the link preview's image; not for a demo) and
// OUT_DIR/badges/<package>.json, and print {digest, live, error, deploy,
// fail} as JSON: `live` false when the reads were missing or unusable, with
// why, and whether to deploy against the live site's status.json (--site;
// see decide()). The output is deterministic (no generation time; the clock
// only decides which watcher keys are fresh enough to use), and status.json
// carries a digest of everything written, so the workflow deploys only when
// something changed.
//
// The publish commits' trailers (the updater writes them):
//   Artcraft-Release: YYYY.MM.DD.N   the release the commit makes
//   Artcraft-Queue: <seconds>        the run's time from its start to
//                                    publish, less its queue-free critical
//                                    path: what runner queueing added
//   Artcraft-Waited: <seconds>       0 when no other update run was in
//                                    progress when this one was dispatched
// The target median takes, per release, moved-at - publishedAt - Queue, only
// where Waited is 0, leaving out a release missing either trailer; the
// all-releases median takes moved-at - publishedAt.
// Hand commits carry none.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareVersions, releasePage } from "../shared/sources.ts";
import type { Pin } from "./lib/util.ts";
import { html, KIND, median, PREVIEW, type DemoInfo } from "./status-page.ts";
import { liveView, REPO, type OpenIssue, type Run } from "./status-live.ts";

export { REPO };

/** When upstream released a version: `published` is GitHub's exact
 * `publishedAt`; `seen` is when the updater first saw it (approximate). */
export type Released = NonNullable<Pin["released"]>;

// ---- History -------------------------------------------------------------

export interface Trailers {
  release: string | null;
  queue: number | null;
  waited: number | null;
}
/** One first-parent commit of `main` that touched versions/*.json, with the
 * files it changed (parsed JSON, or null: deleted or unreadable). */
export interface Commit {
  commit: string;
  at: string;
  trailers: Trailers;
  changes: { path: string; value: any }[];
}
/** `main`'s history of the pins, oldest first, and every file under
 * versions/ at its tip (parsed JSON by path). */
export interface History {
  commits: Commit[];
  tree: Map<string, any>;
}

const RELEASE = /^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/;
/** The trailers of a commit message: "Key: value" lines in its last
 * paragraph. Values that don't read as theirs are null. */
export function trailersOf(message: string): Trailers {
  const last = message.replace(/\s+$/, "").split(/\n\s*\n/).at(-1) ?? "";
  const kv = new Map<string, string>();
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z][A-Za-z-]*):\s*(.*?)\s*$/.exec(line);
    if (m) kv.set(m[1].toLowerCase(), m[2]);
  }
  const seconds = (k: string) => {
    const v = kv.get(k);
    return v !== undefined && /^\d{1,7}$/.test(v) ? Number(v) : null;
  };
  const release = kv.get("artcraft-release") ?? null;
  return { release: release && RELEASE.test(release) ? release : null, queue: seconds("artcraft-queue"), waited: seconds("artcraft-waited") };
}

const parse = (text: string | undefined) => {
  try {
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

/** Blob contents by id, read in one `git cat-file --batch`. */
function readBlobs(ids: string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const buf = execFileSync("git", ["cat-file", "--batch"], { input: unique.join("\n") + "\n", maxBuffer: 1 << 30 });
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const [id, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
    if (type === "missing" || size === undefined) {
      at = nl + 1;
      continue;
    }
    const start = nl + 1, end = start + Number(size);
    map.set(id, buf.subarray(start, end).toString("utf8"));
    at = end + 1;
  }
  return map;
}
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });

/** `main`'s history at REF from git: one walk of its first-parent history
 * of the pins directly in versions/ (not NixOS stable's copies in
 * versions/stable/, which share their names). Every option that changes
 * the result is given, so git's configuration can't: the root commit's
 * files (`--root`), a merge as one change against its first parent, no
 * rename detection. */
export function gitHistory(ref = "HEAD"): History {
  const log = git("log", "--first-parent", "--diff-merges=first-parent", "--root", "--reverse", "--no-renames", "--raw", "--no-abbrev",
    "-z", "--format=%x01%H %cI%x02%B%x03", ref, "--", ":(glob)versions/*.json");
  // NUL-separated tokens: a commit's header ("\x01<hash> <date>\x02<message>\x03"),
  // then ":old-mode new-mode old-blob new-blob status" and the path, by
  // turns. A path is always taken as a path.
  const raw: { commit: string; at: string; message: string; changes: { blob: string; status: string; path: string }[] }[] = [];
  const tokens = log.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i].replace(/^\n/, "");
    const h = t.indexOf("\x01");
    if (h >= 0 && t.includes("\x03", h)) {
      const end = t.indexOf("\x03", h);
      const [head, message] = t.slice(h + 1, end).split("\x02");
      const [commit, at] = head.split(" ");
      raw.push({ commit, at: new Date(at).toISOString(), message: message ?? "", changes: [] });
      t = t.slice(end + 1).replace(/^\n/, "");
    }
    if (t.startsWith(":") && raw.length && i + 1 < tokens.length) {
      const meta = t.split(" ");
      raw.at(-1)!.changes.push({ blob: meta[3], status: meta[4], path: tokens[++i] });
    }
  }
  const listing = git("ls-tree", "-r", "-z", ref, "--", "versions/").split("\0").filter(Boolean)
    .map((l) => { const [meta, path] = l.split("\t"); return { blob: meta.split(" ")[2], path }; })
    .filter((x) => x.path.endsWith(".json"));
  const blobs = readBlobs([...raw.flatMap((c) => c.changes.filter((x) => x.status !== "D").map((x) => x.blob)), ...listing.map((x) => x.blob)]);
  return {
    commits: raw.map((c) => ({ commit: c.commit, at: c.at, trailers: trailersOf(c.message),
      changes: c.changes.map((x) => ({ path: x.path, value: x.status === "D" ? null : parse(blobs.get(x.blob)) })) })),
    tree: new Map(listing.map((x) => [x.path, parse(blobs.get(x.blob))])),
  };
}

/** The same from a fixture's history.json: `{"commits": [{"commit", "at",
 * "message", "files": {"<path>": <JSON> | null}}]}`, oldest first, each
 * commit listing the files it changes. The tree is every file the commits
 * leave. Paths outside versions/*.json (versions/stable/, versions/
 * nixpkgs-stable.json) are part of the tree but never of the history. */
export function fixtureHistory(data: any): History {
  const tree = new Map<string, any>();
  const commits: Commit[] = [];
  for (const c of Array.isArray(data?.commits) ? data.commits : []) {
    const files = Object.entries<any>(c?.files ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, value] of files) value === null ? tree.delete(path) : tree.set(path, value);
    const changes = files.filter(([path]) => TOP.test(path)).map(([path, value]) => ({ path, value }));
    if (changes.length) commits.push({ commit: String(c.commit), at: new Date(c.at).toISOString(), trailers: trailersOf(String(c.message ?? "")), changes });
  }
  return { commits, tree };
}
const TOP = /^versions\/[^/]+\.json$/;

/** A pin as the history reads it: a repository release with packages. */
const isPin = (p: any): p is Pin => typeof p?.repo === "string" && typeof p?.version === "string" && p.packages && typeof p.packages === "object";

/** The pins at the tip, by repository, in SOURCES' path order. */
export function pinsOf(h: History): Pin[] {
  return [...h.tree.entries()].filter(([path, p]) => TOP.test(path) && isPin(p)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, p]) => p as Pin);
}

// ---- Stays ---------------------------------------------------------------

/** One stay of a package on `main`: consecutive first-parent commits in
 * which it has the same version. */
export interface Stay {
  name: string;
  repo: string;
  version: string;
  /** The pin at the stay's last commit, and at its first. */
  pin: Pin;
  first: Pin;
  /** Its first commit: when it reached `main`, and the release that made it. */
  published: Published;
  released: Released | null;
  /** Seconds from the release to the publish (null: not known). */
  gap: number | null;
  /** true for a delivery, or why it isn't one. */
  counted: Counted;
  /** The first commit's run: its Artcraft-Queue and Artcraft-Waited
   * trailers (null: missing). */
  queue: number | null;
  waited: number | null;
}
export interface Published { at: string; commit: string; release: string | null }
export type Counted = true | "added" | "re-added" | "returned" | "older";

/** A release time the page can use, and the gap to a publish; a time that
 * doesn't parse, a kind this page doesn't know, or one after the publish
 * (checked before rounding, so 0.4 s after isn't a gap of -0) is unknown. */
function timing(r: Released | undefined, published: { at: string }): { released: Released | null; gap: number | null } {
  if (!r || !Number.isFinite(Date.parse(r.at)) || !Object.hasOwn(KIND, r.kind)) return { released: null, gap: null };
  const ms = Date.parse(published.at) - Date.parse(r.at);
  return ms >= 0 ? { released: r, gap: Math.round(ms / 1000) } : { released: null, gap: null };
}

/** Every package's stays, oldest first. Packages are followed by name, from
 * the first pin by path that has them, so a file renamed in one commit is
 * one change. */
export function stays(h: History): Map<string, Stay[]> {
  const out = new Map<string, Stay[]>();
  const files = new Map<string, Pin>(); // path -> its pin now
  const gone = new Set<string>(); // names deleted since their last stay
  const byName = () => {
    const m = new Map<string, Pin>();
    for (const path of [...files.keys()].sort()) {
      const pin = files.get(path)!;
      for (const pkg of Object.keys(pin.packages)) if (!m.has(pkg)) m.set(pkg, pin);
    }
    return m;
  };
  for (const c of h.commits) {
    const before = new Set(byName().keys());
    for (const x of c.changes) {
      files.delete(x.path);
      if (isPin(x.value)) files.set(x.path, x.value);
    }
    const present = byName();
    for (const name of before) if (!present.has(name)) gone.add(name);
    for (const [name, pin] of present) {
      const list = out.get(name) ?? [];
      const last = list.at(-1);
      if (last && !gone.has(name) && last.version === pin.version) {
        last.pin = pin;
        continue;
      }
      const counted: Counted = !last ? "added" : gone.has(name) ? "re-added"
        : list.some((s) => s.version === pin.version) ? "returned"
        : compareVersions(pin.version, last.version) < 0 ? "older" : true;
      gone.delete(name);
      const published = { at: c.at, commit: c.commit, release: c.trailers.release };
      list.push({ name, repo: pin.repo, version: pin.version, pin, first: pin, published, released: null, gap: null, counted, queue: c.trailers.queue, waited: c.trailers.waited });
      out.set(name, list);
    }
  }
  // Release times: the stay's newest metadata.
  for (const list of out.values()) for (const s of list) Object.assign(s, timing(s.pin.released, s.published));
  return out;
}

// ---- Rows ----------------------------------------------------------------

/** A delivery as status.json lists it. */
export interface Delivery {
  version: string;
  published: Published;
  released: Released | null;
  gap: number | null;
}
const delivery = (s: Stay): Delivery => ({ version: s.version, published: s.published, released: s.released, gap: s.gap });

export interface Row {
  /** The package. */
  name: string;
  repo: string;
  version: string;
  released: Released | null;
  published: Published | null;
  gap: number | null;
  /** The upstream release page. */
  notes: string | null;
  counted: Counted;
  /** The package's 10 latest deliveries, newest first. */
  history: Delivery[];
  /** The pin's marker, when this package's assets are gone upstream. */
  unavailable: { since: string; issue: number | null } | null;
}

export function rows(h: History, all = stays(h)): Row[] {
  return pinsOf(h).flatMap((pin) => Object.keys(pin.packages).map((name): Row => {
    const list = all.get(name) ?? [];
    const now = list.at(-1);
    const history = list.filter((s) => s.counted === true).slice(-10).reverse().map(delivery);
    const gone = pin.unavailable?.packages.includes(name) ? { since: pin.unavailable!.since, issue: pin.unavailable!.issue } : null;
    return { name, repo: pin.repo, version: pin.version, released: now?.released ?? null, published: now?.published ?? null, gap: now?.gap ?? null,
      notes: pin.tag ? releasePage(pin.repo, pin.tag) : null, counted: now?.counted ?? "added", history, unavailable: gone };
  }));
}

// ---- Speed ---------------------------------------------------------------

/** The target: a median under 9 minutes from publishedAt to `main`
 * moving, over runs with no update run ahead, runner queue time left out. */
export const TARGET_S = 9 * 60;

export interface Median { median: number; count: number }
export interface DeliveryFigure {
  since: string;
  until: string;
  /** The target figure: releases whose run had none ahead (Waited 0) and a
   * known queue time, which is taken out. */
  target: Median | null;
  /** Every release, queueing and runs ahead included: for information. */
  all: Median | null;
}

/** The medians over upstream releases (a repository at a version: an app
 * and its companion are one release, at the earlier publish) in the 30 days
 * up to the newest stay start of any package. A release counts when a
 * member has an exact release time and its delivery isn't negative. Each
 * median is null with fewer than 5; the whole is null when both are. */
export function medianDelivery(all: Map<string, Stay[]>): DeliveryFigure | null {
  const starts = [...all.values()].flat().map((s) => Date.parse(s.published.at));
  if (!starts.length) return null;
  const until = Math.max(...starts), since = until - 30 * 86400e3;
  const releases = new Map<string, Stay[]>();
  for (const list of all.values()) {
    for (const s of list) {
      if (s.counted !== true) continue;
      const key = `${s.repo}\0${s.version}`;
      releases.set(key, [...(releases.get(key) ?? []), s]);
    }
  }
  const every: number[] = [], target: number[] = [];
  for (const members of releases.values()) {
    const first = members.reduce((a, b) => (Date.parse(b.published.at) < Date.parse(a.published.at) ? b : a));
    const publish = Date.parse(first.published.at);
    if (publish < since || publish > until) continue;
    const exact = members.map((m) => m.released).filter((r): r is Released => r?.kind === "published").map((r) => Date.parse(r.at));
    if (!exact.length) continue;
    const ms = publish - Math.min(...exact);
    if (ms < 0) continue;
    every.push(ms / 1000);
    if (first.waited === 0 && first.queue !== null) target.push(Math.max(0, ms / 1000 - first.queue));
  }
  const m = (xs: number[]): Median | null => (xs.length < 5 ? null : { median: median(xs), count: xs.length });
  const out = { since: new Date(since).toISOString(), until: new Date(until).toISOString(), target: m(target), all: m(every) };
  return out.target || out.all ? out : null;
}

// ---- NixOS stable ----------------------------------------------------------

/** NixOS stable at the tip. Two separate things: whether the snapshot has
 * main's pins (`current`; versions, files and unavailable markers), and
 * whether stable builds pass (`builds`, from the open stable-broken issue
 * in the live reads; null without them). An up-to-date snapshot can still
 * fail to build, and a snapshot behind main can build fine.
 *
 * The NixOS release; where the snapshot differs, the snapshot's version and
 * main's of each package (stable null: not in the snapshot; the same
 * version on both sides: main has a newer build of it, or, with `marker`,
 * the same files and only one side marks it unavailable); the snapshot's
 * unavailable packages; and the open stable-behind and stable-broken
 * issues, from the live reads. */
export interface StableView {
  channel: string | null;
  current: boolean;
  differing: { name: string; stable: string | null; main: string; marker?: "main" | "stable" }[];
  unavailable: string[];
  issue: number | null;
  broken: number | null;
  builds: "ok" | "broken" | null;
}
export function stableView(h: History, issues: OpenIssue[] | null = null): StableView {
  const differing: StableView["differing"] = [], unavailable: string[] = [];
  for (const pin of pinsOf(h)) {
    const stable = h.tree.get(`versions/stable/${pin.repo}.json`);
    for (const [pkg, assets] of Object.entries(pin.packages)) {
      const s = isPin(stable) ? stable.packages[pkg] : undefined;
      const marked = (p: Pin) => !!p.unavailable?.packages.includes(pkg);
      if (!s || !isPin(stable)) differing.push({ name: pkg, stable: null, main: pin.version });
      else if (stable.version !== pin.version || JSON.stringify(s) !== JSON.stringify(assets)) differing.push({ name: pkg, stable: stable.version, main: pin.version });
      else if (marked(pin) !== marked(stable)) differing.push({ name: pkg, stable: stable.version, main: pin.version, marker: marked(pin) ? "main" : "stable" });
      if (isPin(stable) && stable.unavailable?.packages.includes(pkg)) unavailable.push(pkg);
    }
  }
  const channel = h.tree.get("versions/nixpkgs-stable.json")?.channel;
  const find = (kind: string) => issues?.filter((i) => i.kind === kind).sort((a, b) => a.number - b.number)[0]?.number ?? null;
  const broken = find("stable-broken");
  return { channel: typeof channel === "string" ? channel : null, current: differing.length === 0, differing, unavailable, issue: find("stable-behind"), broken,
    builds: issues === null ? null : broken === null ? "ok" : "broken" };
}

// ---- Output --------------------------------------------------------------

export function badge(row: Row): { schemaVersion: 1; label: string; message: string; color: string } {
  if (row.unavailable) return { schemaVersion: 1, label: row.name, message: `${row.version} unavailable`, color: "red" };
  let color = "lightgrey";
  // A version that isn't a delivery (added, returned, older) has no delay
  // to colour, as on the page.
  if (row.gap !== null && row.released && row.counted === true) {
    // Only exact times are coloured by the gap.
    if (row.released.kind !== "published") color = "blue";
    else color = row.gap < 3600 ? "brightgreen" : row.gap < 6 * 3600 ? "yellow" : "red";
  }
  return { schemaVersion: 1, label: row.name, message: row.version, color };
}

/** SHA-256 over every file but status.json, sorted by name, each as
 * name\0length\0bytes, then status.json without its digest, the same way. */
export function digest(files: Record<string, string | Buffer>, status: unknown): string {
  const h = createHash("sha256");
  const add = (name: string, text: string | Buffer) => {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    h.update(`${name}\0${bytes.length}\0`);
    h.update(bytes);
  };
  for (const name of Object.keys(files).sort()) add(name, files[name]);
  add("status.json", JSON.stringify(status));
  return h.digest("hex");
}

/** The id of the data a page shows: SHA-256 of status.json's content
 * without its `id`, its `digest` and `live.checked`. The page carries it, so
 * an open tab can tell when the site has newer data; a rebuild that only
 * moves the check time keeps it (the tab takes that time in place). */
export const dataId = (status: Record<string, any>) => {
  const { id: _id, digest: _digest, ...rest } = status;
  const live = rest.live ? { ...rest.live, checked: undefined } : rest.live;
  return createHash("sha256").update(JSON.stringify({ ...rest, live })).digest("hex");
};

/** The live reads, as pages.yml hands them over. */
export interface LiveReads {
  health: any;
  runs: Run[];
  issues: OpenIssue[];
}

export function build(out: string, h: History, repo = REPO, reads: LiveReads | null = null, now = new Date(), demo: DemoInfo | null = null): { digest: string; live: boolean } {
  const all = stays(h);
  const list = rows(h, all);
  // `now` only decides which watcher keys are fresh enough to use; nothing
  // written depends on it otherwise.
  const live = reads ? liveView(pinsOf(h), reads.health, reads.runs, reads.issues, repo, now) : null;
  const stable = stableView(h, reads?.issues ?? null);
  const base = { packages: list, live, stable, delivery: medianDelivery(all) };
  const id = dataId(base);
  const files: Record<string, string | Buffer> = { "index.html": html(list, repo, live, id, stable, base.delivery, demo) };
  // The link preview's image, from this checkout like the page's code
  // (scripts/social-card.sh renders it); a demo has no preview.
  if (!demo) files[PREVIEW.image] = readFileSync(new URL("../docs/social-card.png", import.meta.url));
  for (const r of list) files[`badges/${r.name}.json`] = `${JSON.stringify(badge(r))}\n`;
  // All an open tab checks for (see status-page.ts SCRIPT): the page's id and
  // the check time, in a few bytes instead of the whole status.json.
  files["live.json"] = `${JSON.stringify({ id, checked: live?.checked ?? null })}\n`;
  const status = { ...base, id };
  const d = digest(files, status);
  // Badges of packages that are gone mustn't survive a rebuild in place.
  rmSync(join(out, "badges"), { recursive: true, force: true });
  mkdirSync(join(out, "badges"), { recursive: true });
  // Nor a preview image a demo doesn't have.
  rmSync(join(out, PREVIEW.image), { force: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
  writeFileSync(join(out, "status.json"), `${JSON.stringify({ ...status, digest: d }, null, 2)}\n`);
  return { digest: d, live: live !== null };
}

/** Whether to deploy what was built, against the live site's status.json
 * (null when it couldn't be read: then deploy). Nothing changed: no. The
 * live reads were expected but failed, and the git-derived part is as on
 * the site: no, and the run fails, so a passing outage doesn't flip the
 * site to the plain view and back (the site's `live.checked` ages into its
 * out-of-date note). Before the watcher exists no live reads are expected. */
export function decide(built: { digest: string; packages: Row[]; stable?: StableView; delivery?: unknown }, site: any, liveFailed: boolean): { deploy: boolean; fail: boolean } {
  if (!site || typeof site !== "object") return { deploy: true, fail: false };
  // The stable snapshot's issue numbers and build state come from the live
  // reads, so an outage alone can't move them: only what git says is
  // compared (the NixOS release, the snapshot against main's pins).
  const pinned = (s: any) => JSON.stringify({ packages: s?.packages, channel: s?.stable?.channel, current: s?.stable?.current, differing: s?.stable?.differing,
    unavailable: s?.stable?.unavailable, delivery: s?.delivery });
  if (liveFailed && pinned(site) === pinned(built)) return { deploy: false, fail: true };
  if (site.digest === built.digest) return { deploy: false, fail: false };
  return { deploy: true, fail: false };
}

/** A fixture set: history.json (see fixtureHistory), and optionally
 * health.json (the watcher's reply), reads.json ({runs, issues}, as
 * status-reads.ts writes it) and meta.json ({"now": ISO, the clock for the
 * watcher's keys; "repo"; "demo": DemoInfo}). */
export function readFixtures(dir: string): { history: History; reads: LiveReads | null; now: Date; repo: string; demo: DemoInfo | null } {
  const json = (name: string) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
  const meta = json("meta.json") ?? {};
  const health = json("health.json"), r = json("reads.json");
  const reads = health && r ? { health, runs: Array.isArray(r.runs) ? r.runs : [], issues: Array.isArray(r.issues) ? r.issues : [] } : null;
  const now = Number.isFinite(Date.parse(meta.now ?? "")) ? new Date(meta.now) : new Date(0);
  return { history: fixtureHistory(json("history.json")), reads, now, repo: typeof meta.repo === "string" ? meta.repo : REPO, demo: meta.demo ?? null };
}

/** The command line, for status.ts and status-page.ts alike. */
export function main(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { health: { type: "string" }, reads: { type: "string" }, site: { type: "string" }, fixtures: { type: "string" }, out: { type: "string" } } });
  const out = values.out ?? positionals[0];
  if (!out) {
    console.error("usage: status.ts OUT_DIR [REF] [--health FILE --reads FILE] [--site FILE]\n       status.ts --fixtures DIR --out OUT_DIR");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  if (values.fixtures) {
    const f = readFixtures(values.fixtures);
    const result = build(out, f.history, f.repo, f.reads, f.now, f.demo);
    console.log(JSON.stringify({ digest: result.digest, live: result.live, error: result.live ? null : f.reads ? "the watcher has no usable key" : "no live reads given" }));
    return;
  }
  const ref = values.out ? positionals[0] : positionals[1];
  let reads: LiveReads | null = null, error: string | null = null;
  const expected = !!(values.health || values.reads);
  if (expected) {
    // Fixed reasons: the job summary is public, and must never quote the
    // watcher's reply.
    const json = (file: string | undefined, why: string) => {
      try {
        return JSON.parse(readFileSync(file ?? "", "utf8"));
      } catch {
        throw new Error(why);
      }
    };
    try {
      const health = json(values.health, "the watcher's reply is missing or isn't JSON");
      const r = json(values.reads, "the live job's reads are missing or aren't JSON");
      if (!Array.isArray(r?.runs) || !Array.isArray(r?.issues)) throw new Error("the live job's reads have no runs or issues");
      reads = { health, runs: r.runs, issues: r.issues };
    } catch (e: any) {
      reads = null;
      error = e instanceof Error ? e.message : "the live reads failed";
    }
  } else {
    error = "no live reads given";
  }
  const result = build(out, gitHistory(ref ?? "HEAD"), REPO, reads);
  if (reads && !result.live) error = "the watcher has no usable key";
  let site: any = null;
  try {
    site = values.site ? JSON.parse(readFileSync(values.site, "utf8")) : null;
  } catch {
    site = null;
  }
  const built = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  console.log(JSON.stringify({ digest: result.digest, live: result.live, error: result.live ? null : error, ...decide(built, site, expected && !result.live) }));
}

if (import.meta.main) main(process.argv.slice(2));
