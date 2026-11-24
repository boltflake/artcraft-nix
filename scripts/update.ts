// Resolve every repository's newest eligible release and report what
// changed (the update workflow's read-only resolve job).
//
//   node scripts/update.ts [--write] [--only REPO,...] [--held FILE] [--out FILE]
//
// Prints (or writes to --out) a JSON report:
//   {"checkedAt", "changed": [{repo, from, to, why}], "observations": [...]}
// With --write, changed pins are written to versions/ (and flake.lock, for
// the nixpkgs bump); otherwise nothing on disk changes. GITHUB_TOKEN raises
// the API's rate limit.
//
// One input per repository release: its packages move
// together. Observation kinds (scripts/ci/issues.ts turns them into issues):
//   pass                the pin is the highest eligible release and verified
//   held                an open issue holds this exact release (its
//                       fingerprint); retried only in a run with nothing new
//   integrity           the release didn't verify (held, keyed by its
//                       fingerprint), or a same-tag change that verified
//                       (re-pinned, recorded)
//   incomplete-release  a higher matching release still not eligible an hour
//                       after publishing; `incomplete-ok` when there's none
//   downgrade           the pinned release was pulled (gone, a draft or a
//                       prerelease again); main follows back
//   unavailable         a pinned asset is confirmed gone (404 from the API
//                       and the download host); `available` when not
//   resolve-failed      the repository couldn't be read or a download
//                       didn't work (a retry, never a hold); `probed` when a
//                       read that has no `pass` worked (no eligible release,
//                       the NixOS channels, the stable snapshot's downloads)
//   on-main / waiting / bump-waiting   the nixpkgs bump (as in t3code-nix)
//   stable-*            NixOS stable's pin and snapshot (see stableChecks)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  compareVersions, farEnough, fingerprint, ineligible, fromRest, INCOMPLETE_AFTER_MS, OWNER, RECENT, RELEASE_PAGES, select, SOURCES, versionOf,
  type Release, type Source,
} from "../shared/sources.ts";
import { allTops, Budget, BUMP_BUDGET_MS, compare } from "./lib/nixcache.ts";
import { buildPin } from "./lib/pins.ts";
import { trustedKey } from "./lib/verify.ts";
import { readHeld } from "./ci/held.ts";
import {
  currentPin, exists, Failed, getJson, Integrity, nixpkgsRev, ROOT, run, tryRun, Transient, VERSIONS, writeJson,
  type Pin,
} from "./lib/util.ts";

export interface Observation {
  kind: string;
  /** The repository (or "nixpkgs", "nixpkgs-stable"), or null for run-wide. */
  repo: string | null;
  version: string | null;
  detail: string;
  /** The release's fingerprint, for holds (shared/sources.ts fingerprint). */
  fingerprint?: string;
  /** A downgrade's move: the pulled version and where main goes. */
  from?: string;
  to?: string;
  /** A scope within the repository (a system, or "stable" for the NixOS
   * stable snapshot's pins). */
  channel?: string | null;
  /** `published` only: the landed tree's NixOS-stable inputs (snapshot,
   * markers, nixpkgs-stable) differ from main's before it. */
  stableChanged?: boolean;
  /** `published` only: the landing moved the NixOS-stable snapshot. */
  snapshotMoved?: boolean;
}
export const obs = (kind: string, repo: string | null, version: string | null = null, detail = "", extra: Partial<Observation> = {}): Observation =>
  ({ kind, repo, version, detail, ...extra });

export interface Change {
  repo: string;
  from: string | null;
  to: string;
  why: string;
}

/** What one run found. Pins are kept here until written. */
export class Report {
  readonly checkedAt: string;
  changed: Change[] = [];
  observations: Observation[] = [];
  pins = new Map<string, Pin>();
  /** Each repository's releases as read this run (stableChecks reuses them). */
  listings = new Map<string, Release[]>();
  /** The stable snapshot's changed pins (marker-only), by repository. */
  stablePins = new Map<string, Pin>();
  /** The nixpkgs moves' one absolute deadline this run (ms since the epoch),
   * set by the first of them: they share one budget. */
  bumpDeadline: number | null = null;
  constructor(now: Date) {
    this.checkedAt = now.toISOString();
  }
  observe(o: Observation) {
    this.observations.push(o);
  }
  change(c: Change, pin?: Pin) {
    this.changed = this.changed.filter((x) => x.repo !== c.repo);
    this.changed.push(c);
    if (pin) this.pins.set(c.repo, pin);
  }
  /** Replace everything said about these repositories (the retry pass). */
  forget(repos: Set<string>) {
    this.changed = this.changed.filter((c) => !repos.has(c.repo));
    this.observations = this.observations.filter((o) => !o.repo || !repos.has(o.repo));
    for (const r of repos) this.pins.delete(r);
  }
  toJSON() {
    return { checkedAt: this.checkedAt, changed: this.changed, observations: this.observations };
  }
}

/** A held release: an open hold issue's repository, version and the
 * fingerprint it was seen with (scripts/ci/held.ts). */
export interface Hold {
  repo: string;
  version: string;
  fingerprint: string;
}
const holdKey = (repo: string, fp: string) => `${repo}\0${fp}`;
/** The trusted key's primary fingerprint (keys/trusted.json). */
export const keyId = () => {
  try { return trustedKey().primary; } catch { return "unknown"; }
};

/** How the resolver reaches GitHub; tests replace it. */
export interface Io {
  /** A repository's releases, newest first, page by page until the window
   * is established (farEnough) or RELEASE_PAGES pages; `complete`: every
   * release was read or the window is established. */
  releases(source: Source, pinTag: string | null): Promise<{ items: Release[]; complete: boolean }>;
  /** A release by tag, or null when GitHub says 404. */
  releaseByTag(source: Source, tag: string): Promise<Release | null>;
  /** A pinned asset's state: `present` (the API has its ID), `gone` (a 404
   * for its ID from the API and for its URL from the download host), or
   * `replaced` (its ID is gone, but something else downloads at its URL). */
  asset(source: Source, assetId: number, url: string): Promise<"present" | "gone" | "replaced">;
  buildPin: typeof buildPin;
}
export const io: Io = {
  async releases(source, pinTag) {
    const items: Release[] = [];
    for (let page = 1; page <= RELEASE_PAGES; page++) {
      const got = await getJson(`https://api.github.com/repos/${OWNER}/${source.repo}/releases?per_page=${RECENT}&page=${page}`);
      if (!Array.isArray(got)) throw new Transient(`${source.repo}: the releases didn't come back as a list`);
      items.push(...got.map(fromRest));
      if (got.length < RECENT) return { items, complete: true };
      if (farEnough(source, items, pinTag)) return { items, complete: true };
    }
    // The window read in full: a pulled pin (listed) settles it with an
    // eligible release in it, whatever comes after.
    const listed = !!pinTag && items.some((r) => r.tag === pinTag);
    if (listed && farEnough(source, items, pinTag, true, false, true)) return { items, complete: true };
    // An exactly full last page: is there anything after it at all? (One
    // item past the pages, asked for alone.)
    const past = await getJson(`https://api.github.com/repos/${OWNER}/${source.repo}/releases?per_page=1&page=${RELEASE_PAGES * RECENT + 1}`);
    if (Array.isArray(past) && past.length === 0) return { items, complete: true };
    // A pin the window doesn't list: gone (404 by tag) or pulled (a draft
    // or prerelease by tag) lets a release in the window stand in for it.
    if (pinTag && !listed) {
      const byTag = await io.releaseByTag(source, pinTag);
      const out = byTag === null || byTag.draft || byTag.prerelease;
      if (farEnough(source, items, pinTag, true, out, true)) return { items, complete: true };
    }
    return { items, complete: false };
  },
  async releaseByTag(source, tag) {
    const r = await getJson(`https://api.github.com/repos/${OWNER}/${source.repo}/releases/tags/${encodeURIComponent(tag)}`, { missingOk: true });
    return r ? fromRest(r) : null;
  },
  async asset(source, assetId, url) {
    const api = await getJson(`https://api.github.com/repos/${OWNER}/${source.repo}/releases/assets/${assetId}`, { missingOk: true });
    if (api) return "present";
    return (await exists(url)) ? "replaced" : "gone";
  },
  buildPin,
};

/** The pin's own fingerprint: what it was verified with. */
export function pinFingerprint(source: Source, pin: Pin): string {
  const assets = [
    ...Object.values(pin.packages).flatMap((bySystem) => Object.values(bySystem).map((a) => ({ name: a.url.split("/").pop()!, id: a.assetId, digest: a.digest }))),
    { name: "SHA256SUMS.txt", id: pin.manifest.assetId, digest: pin.manifest.digest },
    { name: "SHA256SUMS.txt.asc", id: pin.signature.assetId, digest: pin.signature.digest },
  ];
  return fingerprint(source, {
    id: pin.releaseId, tag: pin.tag, draft: false, prerelease: false, publishedAt: null, assetsComplete: true,
    assets: assets.map((a) => ({ ...a, state: "uploaded", size: 0 })),
  });
}

/** Whether the pinned release is confirmed pulled: gone (404), a draft or a
 * prerelease again. Listed releases answer it; one not listed (past the
 * page) is looked up by tag. Unknown (an error) is not pulled. */
async function pulled(source: Source, pin: Pin, listed: Release[], i: Io): Promise<boolean> {
  const r = listed.find((x) => x.tag === pin.tag) ?? (await i.releaseByTag(source, pin.tag));
  return !r || r.draft || r.prerelease;
}

/** Which of the pin's packages have an asset confirmed gone, and which stay
 * marked: a marked package leaves the marker only with every one of its
 * pinned assets confirmed present (listed with its pinned ID and
 * digest, or the API still has its ID: asset IDs are never reused, so that's
 * the pinned bytes). Only assets the listing doesn't show are asked about. */
async function assetsNow(source: Source, pin: Pin, listed: Release[], i: Io): Promise<{ gone: string[]; marked: string[]; allPresent: boolean }> {
  const r = listed.find((x) => x.tag === pin.tag);
  const byId = new Map((r?.assets ?? []).map((a) => [Number(a.id), a]));
  const gone: string[] = [];
  const notPresent = new Set<string>();
  for (const [pkg, bySystem] of Object.entries(pin.packages)) {
    for (const a of Object.values(bySystem)) {
      if (byId.get(a.assetId)?.digest === a.digest) continue;
      const state = await i.asset(source, a.assetId, a.url);
      if (state !== "present") notPresent.add(pkg);
      if (state === "gone" && !gone.includes(pkg)) gone.push(pkg);
    }
  }
  // The marker after this probe, per package: a package confirmed gone, or
  // already marked and not yet back with every pinned asset, stays marked.
  const had = new Set(pin.unavailable?.packages ?? []);
  const marked = Object.keys(pin.packages).filter((p) => gone.includes(p) || (had.has(p) && notPresent.has(p)));
  return { gone, marked, allPresent: notPresent.size === 0 };
}

/** One repository: read, select, verify, and say what happened. Then, from
 * this one place, `probed` whenever its releases were read: it closes an
 * earlier resolve-failed of main's scope, and any failure this run (the
 * pulled check, a download) is a problem observed in the same run, which
 * wins. No exit path has to remember it. */
export async function resolveRepo(report: Report, source: Source, held: Set<string>, retry: boolean, now: Date, i: Io = io,
  old: Pin | null = currentPin(source.repo), waits: string[] = []): Promise<void> {
  report.listings.delete(source.repo);
  await resolveSteps(report, source, held, retry, now, i, old, waits);
  if (report.listings.has(source.repo)) report.observe(obs("probed", source.repo, null));
}

async function resolveSteps(report: Report, source: Source, held: Set<string>, retry: boolean, now: Date, i: Io,
  old: Pin | null, waits: string[]): Promise<void> {
  const repo = source.repo;
  let listed: Release[];
  try {
    const got = await i.releases(source, old?.tag ?? null);
    if (!got.complete) {
      // Not read far enough to know: the previous state stands.
      report.observe(obs("resolve-failed", repo, null, `the releases weren't read far enough (${got.items.length} read) to be sure of the selection`));
      return;
    }
    listed = got.items;
    report.listings.set(repo, listed);
  } catch (e: any) {
    report.observe(obs("resolve-failed", repo, null, `couldn't read the releases: ${e.message}`));
    return;
  }
  const { candidate, waiting } = select(source, listed);

  // Higher releases that still aren't eligible.
  for (const { release, reason } of waiting) {
    // The pinned release itself losing files is `unavailable`'s business.
    if (old && release.tag === old.tag) continue;
    const at = release.publishedAt ? Date.parse(release.publishedAt) : NaN;
    if (Number.isFinite(at) && now.getTime() - at > INCOMPLETE_AFTER_MS) {
      report.observe(obs("incomplete-release", repo, versionOf(source, release.tag), `${release.tag}, published ${release.publishedAt}: ${reason}`));
    }
  }
  // Each open incomplete-release issue closes only on evidence for its own
  // release: it became eligible, a higher release is pinned on main, or it
  // was confirmed withdrawn (deleted, a draft or a prerelease again). One
  // that's still incomplete, or just fell off the listing, stays open.
  const highest = candidate ? versionOf(source, candidate.tag) : null;
  for (const v of waits) {
    const tag = `${source.prefix}${v}`;
    let why: string | null = null;
    const listedNow = listed.find((x) => x.tag === tag);
    if (highest === v || (listedNow && ineligible(source, listedNow) === null)) why = `${v} became eligible`;
    else if (old && compareVersions(old.version, v) > 0) why = `a higher release, ${old.version}, is pinned`;
    else {
      let r: Release | null | undefined = listed.find((x) => x.tag === tag);
      if (!r) {
        try { r = await i.releaseByTag(source, tag); } catch { r = undefined; }
      }
      if (r === null || (r && (r.draft || r.prerelease))) why = `${v} was withdrawn (${r === null ? "deleted" : r.draft ? "a draft again" : "a prerelease again"})`;
      else if (r && ineligible(source, r) === null) why = `${v} became eligible`;
    }
    if (why) report.observe(obs("incomplete-ok", repo, v, why));
  }

  let isPulled = false;
  try {
    isPulled = !!old && (await pulled(source, old, listed, i));
  } catch (e: any) {
    report.observe(obs("resolve-failed", repo, old?.version ?? null, `couldn't check the pinned release: ${e.message}`));
    return;
  }

  if (!candidate) {
    if (isPulled) {
      report.observe(obs("downgrade", repo, old!.version, `${old!.tag} was pulled and no eligible release remains, so the pin stays`, { from: old!.version, to: old!.version }));
    }
    if (old) await availability(report, source, old, listed, i, now);
    return;
  }
  const version = versionOf(source, candidate.tag)!;
  const fp = fingerprint(source, candidate);
  const sameTag = !!old && old.tag === candidate.tag;
  if (sameTag && pinFingerprint(source, old!) === fp) {
    report.observe(obs("pass", repo, version, "", { fingerprint: fp }));
    await availability(report, source, old!, listed, i, now);
    return;
  }
  // A move down happens only when the pin was pulled (a higher pin with a
  // lower candidate means the listing missed it: unknown, nothing moves).
  const down = !!old && compareVersions(version, old.version) < 0;
  if (down && !isPulled) {
    report.observe(obs("pass", repo, old!.version, `the pinned ${old!.tag} isn't the highest eligible listed, but it wasn't pulled`));
    await availability(report, source, old!, listed, i, now);
    return;
  }
  if ((held.has(holdKey(repo, fp)) || held.has(holdKey(repo, `${fp}|key:${keyId()}`))) && !retry) {
    report.observe(obs("held", repo, version, "an open issue holds this release", { fingerprint: fp }));
    if (old) await availability(report, source, old, listed, i, now);
    return;
  }
  let pin: Pin;
  try {
    pin = await i.buildPin(source, candidate, old, { now });
  } catch (e: any) {
    if (e instanceof Integrity) {
      // Bound to the trusted key too: after a reviewed key change the release
      // is verified afresh at once.
      report.observe(obs("integrity", repo, version, e.message, { fingerprint: `${fp}|key:${keyId()}` }));
    } else {
      report.observe(obs("resolve-failed", repo, version, e.message));
    }
    if (old) await availability(report, source, old, listed, i, now);
    return;
  }
  const why = sameTag
    ? "the same release's files changed and verify (re-pinned)"
    : down
      ? `${old!.tag} was pulled; back to the highest eligible release`
      : old
        ? "a new release"
        : "first pin";
  report.change({ repo, from: old?.version ?? null, to: version, why }, pin);
  if (sameTag) {
    // For the record, without a fingerprint: it holds nothing.
    report.observe(obs("integrity", repo, version, `${candidate.tag}'s files changed without a new version, and the new files verify against the signed manifest; re-pinned after the tests (for the record)`));
  }
  // The downgrade issue opens once the move has landed (publish says it).
  // An `unavailable` issue closes once main has this pin (the next run's
  // `available`, from main's own pin), not before the change has landed.
}

/** The current pin's downloads: a marker when a pinned asset is confirmed
 * gone, cleared when the assets are back with the pinned digests. A pulled
 * release that still downloads is not unavailable. */
async function availability(report: Report, source: Source, pin: Pin, listed: Release[], i: Io, now: Date): Promise<void> {
  let gone: string[], marked: string[], allPresent: boolean;
  try {
    ({ gone, marked, allPresent } = await assetsNow(source, pin, listed, i));
  } catch (e: any) {
    report.observe(obs("resolve-failed", source.repo, pin.version, `couldn't check the pinned downloads: ${e.message}`));
    return;
  }
  const had = pin.unavailable?.packages ?? [];
  if (gone.length) {
    const since = pin.unavailable?.since ?? now.toISOString();
    report.observe(obs("unavailable", source.repo, pin.version, `upstream's release files of ${marked.join(", ")} are deleted or replaced (since ${since})`));
    if (marked.join() !== had.join()) {
      report.change({ repo: source.repo, from: pin.version, to: pin.version, why: `unavailable: ${marked.join(", ")}` },
        { ...pin, unavailable: { since, issue: pin.unavailable?.issue ?? null, packages: marked } });
    }
    return;
  }
  // `available` is said only of main's pin without a marker (then the
  // change that ended it has landed) and with every pinned asset there: a
  // file replaced at the same URL, before a verified re-pin lands, isn't the
  // pin available.
  if (!had.length && allPresent) report.observe(obs("available", source.repo, pin.version));
  // Some marked packages back with every pinned asset, others not yet: the
  // marker narrows to those still missing. Every marked one back: cleared
  // (another package's replaced file is a same-tag change, on its own path).
  if (marked.length && marked.join() !== had.join()) {
    report.observe(obs("unavailable", source.repo, pin.version, `upstream's release files of ${marked.join(", ")} are deleted or replaced (since ${pin.unavailable!.since})`));
    report.change({ repo: source.repo, from: pin.version, to: pin.version, why: `unavailable: ${marked.join(", ")}` },
      { ...pin, unavailable: { ...pin.unavailable!, packages: marked } });
  } else if (had.length && !marked.length) {
    const { unavailable: _, ...rest } = pin;
    report.change({ repo: source.repo, from: pin.version, to: pin.version, why: "the assets came back with the pinned digests" }, rest as Pin);
  }
}

/** The held releases a run retries: when nothing else is new (as in
 * t3code-nix), every repository that reported `held`. */
export function retryRepos(report: Report, nixpkgsNew: boolean): Set<string> {
  if (report.changed.length || nixpkgsNew) return new Set();
  return new Set(report.observations.filter((o) => o.kind === "held" && o.repo && SOURCES.some((x) => x.repo === o.repo)).map((o) => o.repo!));
}

// The nixpkgs bump, as in t3code-nix's bumpDue, with two changes: it's due
// once an app release has reached main since the last bump and that bump is
// a day old or more (so at most once a day), or a week after the last bump,
// in any run; and in a run with app releases its
// cache check gets 60 seconds instead of BUMP_BUDGET_MS.
export const DAY_MS = 24 * 60 * 60 * 1000;
export const BUMP_FLOOR_MS = 7 * DAY_MS;
export const BUMP_ISSUE_MS = 14 * DAY_MS;
/** The budget in a run with app releases, and its minimum. */
export const RELEASE_RUN_BUMP_MS = 60_000;
/** Below this much time left the bump waits (lowered to match in a run with
 * app releases). */
export const MIN_BUMP_MS = 3 * 60_000;
export const RELEASE_RUN_MIN_BUMP_MS = 30_000;

export interface LockHistory {
  /** When flake.lock last changed on main (ms), or null. */
  lockChangedAt: number | null;
  /** When the first commit with an app release (a release trailer) reached
   * main after that, or null. */
  releaseSince: number | null;
}
export const history = {
  read(dir = ROOT, file = "flake.lock"): LockHistory {
    const g = (...args: string[]) => tryRun("git", ["-C", dir, ...args]);
    const last = g("log", "-1", "--format=%H %ct", "HEAD", "--", file);
    if (last.status !== 0) throw new Failed(`git log: ${last.stderr}`);
    const [sha, ct] = last.stdout.split(" ");
    const since = g("log", "--reverse", "--format=%ct", "--grep=^Artcraft-Release: ", sha ? `${sha}..HEAD` : "HEAD");
    const first = since.status === 0 ? since.stdout.split("\n").find(Boolean) : undefined;
    return { lockChangedAt: sha ? Number(ct) * 1000 : null, releaseSince: first ? Number(first) * 1000 : null };
  },
};

/** Why the bump is due, or null: an app release reached main since the
 * last bump, and that bump is a day old or more (so at most one a day); or a
 * week since the last bump, in any run. */
export function bumpDue(h: LockHistory, now: Date): string | null {
  const age = h.lockChangedAt === null ? Infinity : now.getTime() - h.lockChangedAt;
  if (h.releaseSince !== null && age >= DAY_MS) return "an app release reached main since the last nixpkgs bump, a day or more ago";
  if (age > BUMP_FLOOR_MS) return "a week since the last nixpkgs bump";
  return null;
}
/** The cache check's budget: 60 s in a run with app releases (off a
 * release's critical path), the full budget otherwise. */
export const bumpBudget = (report: Report) =>
  // A held release this run will retry counts as an app release too.
  report.changed.some((c) => c.repo !== "nixpkgs" && c.repo !== STABLE_PIN) || report.observations.some((o) => o.kind === "held")
    ? { budget: RELEASE_RUN_BUMP_MS, min: RELEASE_RUN_MIN_BUMP_MS }
    : { budget: BUMP_BUDGET_MS, min: MIN_BUMP_MS };

export interface BumpResult {
  from: string | null;
  to: string | null;
  offered: boolean;
  missing: string[];
  unknown: string[];
}
/** Bump flake.lock to the newest nixos-unstable and check the cache; put the
 * lock back unless the bump is offered, or if the budget runs out (the
 * budget covers the lock update, the evaluations and the probes). */
export const bumper = {
  tops: (dir: string, budget: Budget) => allTops(dir, budget),
  update: (dir: string, budget: Budget) => { run("nix", ["flake", "update", "nixpkgs"], { cwd: dir, timeout: budget.left(3 * 60_000) }); },
  compare: (base: Record<string, string[]>, next: Record<string, string[]>, budget: Budget) => compare(base, next, null, undefined, budget),
  async run(dir = ROOT, budgetMs = BUMP_BUDGET_MS): Promise<BumpResult> {
    const budget = new Budget(budgetMs);
    const path = join(dir, "flake.lock");
    const before = readFileSync(path, "utf8");
    const from = nixpkgsRev(before);
    const declined = (r: Partial<BumpResult>): BumpResult => {
      writeFileSync(path, before);
      return { from, to: null, offered: false, missing: [], unknown: [], ...r };
    };
    const why = (e: any) => String(e?.stderr || e?.message || e).trim().split("\n").slice(-5).join("\n");
    let base: Record<string, string[]>;
    try { base = bumper.tops(dir, budget); } catch (e) { return declined({ unknown: [`the packages don't evaluate at ${from}: ${why(e)}`] }); }
    try { bumper.update(dir, budget); } catch (e) { return declined({ unknown: [`nix flake update failed: ${why(e)}`] }); }
    const to = nixpkgsRev(readFileSync(path, "utf8"));
    if (!to || to === from) return declined({ to });
    let next: Record<string, string[]>;
    try { next = bumper.tops(dir, budget); } catch (e) { return declined({ to, unknown: [`the packages don't evaluate at ${to}: ${why(e)}`] }); }
    let verdict;
    try { verdict = await bumper.compare(base, next, budget); } catch (e) { return declined({ to, unknown: [`the cache check didn't finish: ${why(e)}`] }); }
    // A lookup that started in time can end after the deadline: the budget
    // covers the whole check, so a late verdict is declined too.
    if (budget.over) return declined({ to, unknown: ["the cache check ran past its budget"] });
    if (verdict.missing.length || verdict.unknown.length) return declined({ to, ...verdict });
    return { from, to, offered: true, missing: [], unknown: [] };
  },
};

/** What's left of the moves' shared budget: one absolute deadline, set at
 * the first ask (the bump budget from then, within the run's own). */
export function bumpLeft(report: Report, clock: () => number, startedAt: number, runBudgetMs: number): number {
  if (report.bumpDeadline === null) report.bumpDeadline = clock() + bumpBudget(report).budget;
  return Math.min(report.bumpDeadline - clock(), startedAt + runBudgetMs - clock());
}

export async function maybeBump(report: Report, held: Set<string>, now: Date, h: LockHistory = history.read(), clock = Date.now,
  startedAt = clock(), runBudgetMs = 20 * 60_000, retry = false): Promise<void> {
  const head = tryRun("git", ["-C", ROOT, "show", "HEAD:flake.lock"]);
  const mainRev = head.status === 0 ? nixpkgsRev(head.stdout) : null;
  if (mainRev) report.observe(obs("on-main", "nixpkgs", mainRev));
  const why = bumpDue(h, now);
  if (!why) return;
  const left = bumpLeft(report, clock, startedAt, runBudgetMs);
  const { min } = bumpBudget(report);
  // The lock as it was, local edits included, to put back on a hold.
  const lockPath = join(ROOT, "flake.lock");
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
  const r: BumpResult = left < min
    ? { from: mainRev, to: null, offered: false, missing: [], unknown: ["not enough time left in this run"] }
    : await bumper.run(ROOT, left);
  if (r.offered) {
    if (retry || !held.has(holdKey("nixpkgs", r.to!))) report.change({ repo: "nixpkgs", from: r.from, to: r.to!, why });
    else {
      // Held: put flake.lock back as it was, so the candidate doesn't carry it.
      if (lockBefore !== null) writeFileSync(lockPath, lockBefore);
      report.observe(obs("held", "nixpkgs", r.to, "an open issue holds this revision", { fingerprint: r.to! }));
    }
    return;
  }
  if (!r.missing.length && !r.unknown.length) return; // nixos-unstable hasn't moved
  const lines = [...r.missing.slice(0, 30).map((m) => `not on cache.nixos.org yet: ${m}`), ...r.unknown.map((u) => `couldn't check: ${u}`)];
  report.observe(obs("waiting", "nixpkgs", r.to, [`bump due (${why}) waits; a later run tries again`, ...lines].join("\n")));
  if (h.lockChangedAt === null || now.getTime() - h.lockChangedAt > BUMP_ISSUE_MS) {
    report.observe(obs("bump-waiting", "nixpkgs", r.from, ["flake.lock hasn't changed on main for more than 14 days, and the bump waits:", ...lines].join("\n")));
  }
}

// NixOS stable: the pin follows the current NixOS release once it's out of
// beta, and the snapshot's downloads are probed (stable-unfetchable).
export const STABLE_PIN = "nixpkgs-stable";
const CHANNELS = "https://channels.nixos.org";
/** How the stable pin's move reaches the outside; tests replace it. */
export const stableIo = {
  /** Is the release channel out (its redirect target has no "beta")? */
  async released(channel: string, timeoutMs = 30_000): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`${CHANNELS}/${channel}`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) { throw new Transient(`${channel}: ${e?.message ?? e}`); }
    if (res.status === 404) return false;
    const to = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !to) throw new Transient(`${channel}: HTTP ${res.status} without a redirect`);
    return !/beta/i.test(to.split("/").pop() ?? "");
  },
  async rev(channel: string, timeoutMs = 30_000): Promise<string> {
    let text: string;
    try {
      const res = await fetch(`${CHANNELS}/${channel}/git-revision`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = (await res.text()).trim();
    } catch (e: any) { throw new Transient(`${channel}: git-revision: ${e?.message ?? e}`); }
    if (!/^[0-9a-f]{40}$/.test(text)) throw new Failed(`${channel}: git-revision is ${JSON.stringify(text.slice(0, 60))}`);
    return text;
  },
  prefetch(rev: string, timeout: number): string {
    const out = run("nix", ["flake", "prefetch", "--json", `https://github.com/NixOS/nixpkgs/archive/${rev}.tar.gz`], { cwd: ROOT, timeout });
    const hash = JSON.parse(out)?.hash;
    if (typeof hash !== "string" || !hash.startsWith("sha256-")) throw new Failed(`nix flake prefetch gave no hash for ${rev}`);
    return hash;
  },
  /** The cache check for a move: the stable set at the current pin against
   * the stable set at the proposed one (the pin file swapped in, and put
   * back unless the move is offered). */
  async check(dir: string, budget: Budget, pin: object) {
    const path = join(dir, "versions", `${STABLE_PIN}.json`);
    const before = readFileSync(path, "utf8");
    const base = allTops(dir, budget, "stable");
    writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
    try {
      const v = await compare(base, allTops(dir, budget, "stable"), null, undefined, budget);
      if (budget.over) return { missing: [], unknown: ["the cache check ran past its budget"] };
      return v;
    } finally {
      writeFileSync(path, before);
    }
  },
};
/** The newest released stable channel, from `start` on. */
export async function newestStable(start: string, i = stableIo, budget: Budget | null = null): Promise<string> {
  let channel = start;
  for (let k = 0; k < 4; k++) {
    const next = nextRelease(channel);
    if (!(await i.released(next, budget ? budget.left(30_000) : 30_000))) break;
    channel = next;
  }
  return channel;
}
/** Move versions/nixpkgs-stable.json, as in t3code-nix's maybeBumpStable:
 * at once to a newer NixOS release once it's out of beta; within its
 * release, by the nixpkgs bump's due rule counted from its own file; only
 * once the stable set needs nothing cache.nixos.org lacks. Its own input
 * (held by its revision, like nixpkgs). Reports `on-main` for main's
 * revision and `waiting` when it declines a move; `bump-waiting` after 14
 * days. */
export async function maybeBumpStable(report: Report, held: Set<string>, now: Date, clock = Date.now, startedAt = clock(),
  runBudgetMs = 20 * 60_000, i = stableIo, dir = ROOT, h: LockHistory = history.read(dir, `versions/${STABLE_PIN}.json`), retry = false): Promise<void> {
  const path = join(dir, "versions", `${STABLE_PIN}.json`);
  if (!existsSync(path)) return;
  const cur = JSON.parse(readFileSync(path, "utf8"));
  report.observe(obs("on-main", STABLE_PIN, cur.rev));
  const waiting = (to: string | null, why: string, cache = false) => {
    report.observe(obs("waiting", STABLE_PIN, to, why));
    if (cache && (h.lockChangedAt === null || now.getTime() - h.lockChangedAt > BUMP_ISSUE_MS)) {
      report.observe(obs("bump-waiting", STABLE_PIN, cur.rev, `versions/${STABLE_PIN}.json hasn't changed on main for more than 14 days, and the move waits: ${why.split("\n")[0]}`));
    }
  };
  const { min } = bumpBudget(report);
  // The deadline the nixpkgs bump set, so the two share one.
  const left = bumpLeft(report, clock, startedAt, runBudgetMs);
  if (left < min) return waiting(null, "not enough time left in this run to look for a move");
  const budget = new Budget(left, clock);
  let channel: string, rev: string;
  try {
    channel = await newestStable(cur.channel, i, budget);
    rev = await i.rev(channel, budget.left(30_000));
  } catch (e: any) {
    return report.observe(obs("resolve-failed", STABLE_PIN, null, `couldn't read the NixOS channels: ${e.message}`));
  }
  report.observe(obs("probed", STABLE_PIN, rev));
  if (rev === cur.rev && channel === cur.channel) return;
  const why = channel !== cur.channel ? `NixOS ${channel.replace("nixos-", "")} is out` : bumpDue(h, now)?.replace("nixpkgs bump", "nixpkgs-stable move");
  if (!why) return waiting(rev, `${channel} moved; a move isn't due yet`);
  if (!retry && held.has(holdKey(STABLE_PIN, rev))) return report.observe(obs("held", STABLE_PIN, rev, "an open issue holds this revision", { fingerprint: rev }));
  try {
    const narHash = i.prefetch(rev, budget.left(3 * 60_000));
    const pin = { name: STABLE_PIN, channel, rev, narHash };
    const verdict = await i.check(dir, budget, pin);
    if (verdict.missing.length || verdict.unknown.length) {
      const lines = [...verdict.missing.slice(0, 30).map((m: string) => `not on cache.nixos.org yet: ${m}`), ...verdict.unknown.map((u: string) => `couldn't check: ${u}`)];
      return waiting(rev, [`move due (${why}) waits for the cache`, ...lines].join("\n"), true);
    }
    writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
    report.change({ repo: STABLE_PIN, from: cur.rev, to: rev, why });
  } catch (e: any) {
    return waiting(rev, `couldn't check the move: ${String(e?.message ?? e).split("\n").slice(-3).join(" ")}`, true);
  }
}
export function nextRelease(channel: string): string {
  const m = /^nixos-(\d\d)\.(05|11)$/.exec(channel);
  if (!m) throw new Error(`not a NixOS release channel: ${channel}`);
  return m[2] === "05" ? `nixos-${m[1]}.11` : `nixos-${String(Number(m[1]) + 1).padStart(2, "0")}.05`;
}
/** The newest release whose month has come (it may still be in beta). */
export function latestRelease(now: Date): string {
  const yy = now.getUTCFullYear() % 100, month = now.getUTCMonth() + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return month >= 11 ? `nixos-${pad(yy)}.11` : month >= 5 ? `nixos-${pad(yy)}.05` : `nixos-${pad(yy - 1)}.11`;
}
/** The NixOS-stable snapshot's own downloads, each snapshot pin probed
 * on its own. A deleted asset gets a marker in versions/stable/<repo>.json,
 * a marker-only change tested like any other (candidate.ts allows it), and
 * an `unavailable` issue scoped to the snapshot (channel "stable"); the
 * assets confirmed back clear it. Pins equal to main's reuse this run's
 * listing. `stable-unfetchable` sums it up for the whole snapshot. */
export async function stableChecks(report: Report, i: Io = io, dir = join(VERSIONS, "stable")): Promise<void> {
  const gone: string[] = [];
  let unknown = false;
  for (const source of SOURCES) {
    const pin = currentPin(source.repo, dir);
    if (!pin) continue;
    let state;
    try {
      state = await assetsNow(source, pin, report.listings.get(source.repo) ?? [], i);
    } catch (e: any) {
      unknown = true;
      report.observe(obs("resolve-failed", source.repo, pin.version, `couldn't probe the stable snapshot's downloads: ${e.message}`, { channel: "stable" }));
      continue;
    }
    report.observe(obs("probed", source.repo, pin.version, "", { channel: "stable" }));
    const had = pin.unavailable?.packages ?? [];
    if (state.gone.length) {
      gone.push(...state.gone.map((p) => `${p} ${pin.version}`));
      const since = pin.unavailable?.since ?? report.checkedAt;
      report.observe(obs("unavailable", source.repo, pin.version, `the NixOS-stable snapshot's ${state.marked.join(", ")} ${pin.version}: upstream's files are deleted or replaced (since ${since})`, { channel: "stable" }));
      if (state.marked.join() !== had.join()) {
        report.stablePins.set(source.repo, { ...pin, unavailable: { since, issue: pin.unavailable?.issue ?? null, packages: state.marked } });
      }
    } else {
      if (!had.length && state.allPresent) report.observe(obs("available", source.repo, pin.version, "", { channel: "stable" }));
      // A replaced file isn't fetchable at its pinned hash: no claim either
      // way (marked or not).
      if (!state.allPresent) unknown = true;
      if (state.marked.length && state.marked.join() !== had.join()) {
        report.observe(obs("unavailable", source.repo, pin.version, `the NixOS-stable snapshot's ${state.marked.join(", ")} ${pin.version}: upstream's files are deleted or replaced (since ${pin.unavailable!.since})`, { channel: "stable" }));
        report.stablePins.set(source.repo, { ...pin, unavailable: { ...pin.unavailable!, packages: state.marked } });
      } else if (had.length && !state.marked.length) {
        const { unavailable: _, ...rest } = pin;
        report.stablePins.set(source.repo, rest as Pin);
      }
    }
  }
  if (gone.length) report.observe(obs("stable-unfetchable", null, null, `the stable snapshot's downloads are gone: ${gone.join(", ")}`));
  else if (!unknown) report.observe(obs("fetchable", null, null));
}

async function resolveAll(report: Report, sources: Source[], held: Set<string>, retry: boolean, now: Date, i: Io, waits: { repo: string; version: string }[] = []) {
  // In order: the output is deterministic and errors stay attributable.
  for (const s of sources) await resolveRepo(report, s, held, retry, now, i, currentPin(s.repo), waits.filter((w) => w.repo === s.repo).map((w) => w.version));
}

export async function main(argv: string[], i: Io = io, clock = Date.now): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    write: { type: "boolean" }, only: { type: "string" }, held: { type: "string" }, out: { type: "string" },
    "no-bump": { type: "boolean" },
  } });
  const startedAt = clock();
  const now = new Date(startedAt);
  const only = values.only ? new Set(values.only.split(",")) : null;
  const sources = SOURCES.filter((s) => !only || only.has(s.repo));
  if (only && sources.length !== only.size) throw new Failed(`unknown repository in --only ${values.only}`);
  const heldFile = values.held ?? process.env.HELD_JSON;
  const { holds, waiting: waits } = readHeld(heldFile);
  const held = new Set(holds.map((h) => holdKey(h.repo, h.fingerprint)));

  const report = new Report(now);
  // The moves' files as they are now (local edits included): without
  // --write they're put back exactly so.
  const moveFiles = [join(ROOT, "flake.lock"), join(VERSIONS, `${STABLE_PIN}.json`)];
  const before = new Map(moveFiles.filter((f) => existsSync(f)).map((f) => [f, readFileSync(f, "utf8")]));
  await resolveAll(report, sources, held, false, now, i, waits);
  if (!only && !values["no-bump"]) {
    await maybeBump(report, held, now, history.read(), clock, startedAt);
    await maybeBumpStable(report, held, now, clock, startedAt);
  }
  const retry = retryRepos(report, report.changed.some((c) => c.repo === "nixpkgs" || c.repo === STABLE_PIN));
  if (retry.size) {
    report.forget(retry);
    await resolveAll(report, sources.filter((s) => retry.has(s.repo)), held, true, now, i, waits);
  }
  // A held nixpkgs or nixpkgs-stable revision gets the same idle retry: in a
  // run with nothing else new, it's offered once more despite its hold.
  if (!only && !values["no-bump"] && !report.changed.length) {
    const heldMoves = new Set(report.observations.filter((o) => o.kind === "held" && (o.repo === "nixpkgs" || o.repo === STABLE_PIN)).map((o) => o.repo!));
    if (heldMoves.size) {
      report.forget(heldMoves);
      if (heldMoves.has("nixpkgs")) await maybeBump(report, held, now, history.read(), clock, startedAt, undefined, true);
      if (heldMoves.has(STABLE_PIN)) await maybeBumpStable(report, held, now, clock, startedAt, undefined, undefined, undefined, undefined, true);
    }
  }
  if (!only) await stableChecks(report, i);

  if (values.write) {
    for (const [repo, pin] of report.pins) writeJson(join(VERSIONS, `${repo}.json`), pin);
    for (const [repo, pin] of report.stablePins) writeJson(join(VERSIONS, "stable", `${repo}.json`), pin);
  } else {
    // Without --write the moves' files are put back as they were.
    for (const [f, text] of before) if (readFileSync(f, "utf8") !== text) writeFileSync(f, text);
  }
  const text = JSON.stringify(report, null, 2);
  if (values.out) writeFileSync(values.out, text + "\n");
  else console.log(text);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`update: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
    process.exit(1);
  });
}

export { Transient };
