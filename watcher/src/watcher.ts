// The release watcher. One cron, every minute: one
// GraphQL query reads every repository's recent releases, the pins'
// folder on main, and the required assets of each release whose state isn't
// settled yet. A change starts the update workflow (workflow_dispatch);
// what gets pinned is decided there, so triggering is at least once: a lost
// or repeated trigger only delays an update or starts a run with nothing to
// do.
//
// What the watcher keeps per repository: the highest eligible release (its
// tag, version, fingerprint and firstSeen), the tags above it still waiting
// to become eligible, and the pinned release's fingerprint. A change to any
// of them dispatches: a new eligible release, a release that becomes
// eligible later with no new tag, a pulled one, a same-tag re-upload
// (digests or only asset IDs), a repaired upload on a held release (the
// highest eligible one not pinned yet), a waiting tag appearing or being
// withdrawn. The pin moving on main is the updater's own doing: it is
// saved but doesn't dispatch.
//
// Asset IDs here are GraphQL node IDs (GraphQL has no databaseId for
// release assets), so the fingerprints are compared only with this
// watcher's own earlier state, never with the pins' REST IDs.
//
// Which releases' assets are read: the pin, the eligible release and the
// waiting tags (the "window") every minute, in the one query; a tag not in
// the window (a new one, or a known one that becomes the highest after a
// withdrawal or while the pin is pulled) needs a follow-up query, and so do
// the pins themselves when the folder's tree changed and further release
// pages. Follow-ups are bounded by ASSET_BUDGET per sweep; a repository
// whose data couldn't be read in full this sweep keeps its previous state
// (and the tags read so far are read first next time, so it gets there).
//
// The state is one KV key, read once a sweep and written at most once: only
// when something changed (including a back-off starting, the dispatch being
// sent, the deployed version or the version that last polled, or the pin
// moving), plus a 15-minute heartbeat. Errors and recoveries wait for the
// heartbeat, so writes stay near 100 to 150 a day (the free plan allows
// 1,000 for the account, shared with t3code-nix's ~200). The timed sends
// (below) add none.
//
// A back-off that would skip the next minute's sweep is saved at once (each
// cron run is a fresh isolate: one only in memory would be forgotten and
// asked through). A back-off that follows on from a saved one lasts at
// least twice as long, up to MAX_BACKOFF_MS, so a rate limit that goes on
// for a day costs about 30 writes on top of the heartbeats, not one a
// minute.
//
// While KV writes fail (the quota spent, an outage), polling and
// dispatching go on: the change isn't saved, so each sweep sees it again
// and dispatches again, at most once a minute, until a write succeeds; the
// update workflow's concurrency group keeps one run waiting. While KV reads
// fail, nothing can be compared, so every sweep dispatches and none
// writes (writing would replace the saved firstSeen times).
//
// KV is eventually consistent: a sweep can read the key a little old. Then
// it may see a change again, dispatch once more (harmless) and give it a
// firstSeen up to that delay later.
//
// It also starts pages.yml and health.yml about hourly (sendTimed), as
// GitHub's schedule trigger drops runs: only in a sweep that writes anyway,
// so they add no KV writes, and only after a write that was saved recently.
//
// Pure apart from the injected fetch, KV and clock, so tests run it in Node.
import {
  assetsFromGraphql, assetsQuery, compareVersions, farEnough, fingerprint, RECENT, RELEASE_PAGES, repoQuery, requiredNames, select, SOURCES, versionOf,
  type Release, type ReleaseAsset, type Selection, type Source,
} from "../../shared/sources.ts";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
export interface Env {
  STATE: KV;
  /** Fine-grained token: Actions write on REPO (dispatch), and read access
   * to public repositories (GraphQL, and REPO's contents for the pins). */
  GITHUB_TOKEN: string;
  HEALTH_TOKEN: string;
  /** This flake's repository, owner/name: dispatched, and its pins read. */
  REPO: string;
  CF_VERSION?: { id: string };
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const KEY = "state";
export const UA = "artcraft-nix-watcher (https://github.com/boltflake/artcraft-nix)";
const TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 15 * 60_000;
/** Follow-up GraphQL queries one sweep may send after the first (the free
 * Worker allows 50 outside requests a run; each follow-up covers every
 * repository that needs one at once). */
export const ASSET_BUDGET = 4;
/** Tags whose assets one follow-up reads per repository, highest first, so
 * a repository with many new tags can't make one reply huge. */
export const TAGS_PER_ROUND = 4;
/** Tags remembered from a sweep that ran out of budget, per repository:
 * enough for every release a reader's pages can list, so the list never
 * fills before the repository is decided. Each such sweep reads at least
 * one round of TAGS_PER_ROUND tags it hadn't (the pages take at most
 * RELEASE_PAGES - 1 rounds and the pins one, fewer than ASSET_BUDGET), and
 * remembers them, so a repository gets there within a bounded number of
 * sweeps. */
export const WATCH_MAX = RELEASE_PAGES * RECENT;
/** The longest a server may make the watcher wait: a Retry-After or reset
 * further off is cut to this, so one bad header can't silence it for days
 * (or, unparsable, stop the cron). */
export const MAX_BACKOFF_MS = 60 * 60_000;
/** A retry time from a server, or null: only a real time in the future, at
 * most MAX_BACKOFF_MS away. */
export const backoffUntil = (at: number | null, now: number): number | null =>
  at !== null && Number.isFinite(at) && at > now ? Math.min(at, now + MAX_BACKOFF_MS) : null;

export type ErrorKind = "auth" | "rate-limit" | "http" | "network" | "timeout" | "parse" | "not-found" | "truncated" | "budget";
export class SourceError extends Error {
  kind: ErrorKind;
  retryAt: number | null;
  constructor(kind: ErrorKind, message: string, retryAt: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAt = retryAt;
  }
}
const asError = (e: any, kind: ErrorKind = "parse") => (e instanceof SourceError ? e : new SourceError(kind, String(e?.message ?? e)));

/** One request with a timeout, sorted into an error kind on failure. A 403
 * with rate-limit headers is a rate limit, not an auth error. `timed`: a
 * timed workflow dispatch (sendTimed), whose refusal for a disabled
 * workflow is an http error (see disabledWorkflow). */
export async function request(f: Fetch, url: string, now: number, init: RequestInit = {}, timed = false): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { ...init, headers: { "User-Agent": UA, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e: any) {
    throw new SourceError(e?.name === "TimeoutError" ? "timeout" : "network", `${url}: ${e?.message ?? e}`);
  }
  if (res.ok) return res;
  const after = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = res.status === 429 || (res.status === 403 && (after !== null || res.headers.get("x-ratelimit-remaining") === "0"));
  if (timed && !limited && (res.status === 403 || res.status === 422)) {
    let message = "";
    try {
      message = String((await res.json())?.message ?? "");
    } catch {
      // Unreadable: classified by its status below.
    }
    if (disabledWorkflow(message)) throw new SourceError("http", `${url}: HTTP ${res.status}: ${message.slice(0, 200)}`);
  } else {
    await res.body?.cancel();
  }
  if (limited) {
    // Retry-After is seconds or an HTTP date; GitHub also sends the reset time.
    const date = after && !/^\d+$/.test(after) ? Date.parse(after) : NaN;
    const at = after && /^\d+$/.test(after) ? now + Number(after) * 1000
      : Number.isFinite(date) ? date
      : reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
    throw new SourceError("rate-limit", `${url}: HTTP ${res.status}`, backoffUntil(at, now));
  }
  throw new SourceError(res.status === 401 || res.status === 403 ? "auth" : "http", `${url}: HTTP ${res.status}`);
}

/** Whether a refused dispatch's message says the workflow is disabled: not
 * the token's fault, so an http error, not auth (whose fix, a new token,
 * would be wrong). GitHub documents no status or wording for this, so the
 * match is on the message (seen in the wild: "Cannot trigger a
 * 'workflow_dispatch' on a disabled workflow"); anything else keeps its
 * status's kind. */
export const disabledWorkflow = (message: string) =>
  /\b(workflow (is )?disabled|disabled workflow)\b/i.test(message);

/** One GraphQL query: its data, and the top-level aliases GitHub couldn't
 * find (a renamed or deleted repository), which leave the rest good. Any
 * other error fails the query, sorted by its type. */
async function graphql(f: Fetch, env: Env, now: number, query: string): Promise<{ data: any; notFound: Set<string> }> {
  const res = await request(f, "https://api.github.com/graphql", now, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query { ${query} }` }),
  });
  let doc: any;
  try {
    doc = await res.json();
  } catch (e: any) {
    throw new SourceError("parse", `GraphQL: ${e?.message ?? e}`);
  }
  const errors: any[] = Array.isArray(doc?.errors) ? doc.errors : doc?.errors ? [doc.errors] : [];
  if (doc?.data && errors.every((e) => e?.type === "NOT_FOUND")) {
    return { data: doc.data, notFound: new Set(errors.map((e) => String(e?.path?.[0] ?? ""))) };
  }
  const types = new Set<string>(errors.map((e: any) => e?.type));
  const kind = types.has("RATE_LIMITED") ? "rate-limit" : types.has("FORBIDDEN") || types.has("UNAUTHORIZED") ? "auth" : "parse";
  // GitHub's GraphQL limit comes as HTTP 200 with RATE_LIMITED; wait for its reset.
  const reset = kind === "rate-limit" ? backoffUntil(Number(res.headers.get("x-ratelimit-reset")) * 1000 || null, now) : null;
  throw new SourceError(kind, `GraphQL: ${JSON.stringify(doc?.errors ?? doc).slice(0, 300)}`, reset);
}

interface Failure { kind: ErrorKind; message: string; since: string }
/** A request's failures and back-off: `retryAt` is when it may be asked
 * again, `retryMs` how long that back-off was (the next one, following on,
 * lasts at least twice as long). */
interface Backoff { error?: Failure; retryAt?: string; retryMs?: number }
export interface RepoState {
  /** The pin as of the last full read, and its release's fingerprint then
   * (null: the release wasn't there). `pulled`: the release is gone, a
   * draft or a prerelease again (the status page shows it pulled). */
  pinned: { tag: string; fingerprint: string | null; pulled?: boolean } | null;
  /** The highest eligible release by semver, and when it was first seen. */
  eligible: { tag: string; version: string; fingerprint: string; firstSeen: string } | null;
  /** Published releases with a matching tag above it, not eligible yet. */
  waiting: Record<string, { firstSeen: string }>;
  /** When the repository was last read in full: polling freshness. */
  read: string | null;
  /** Why the last sweeps couldn't read it in full, since when. */
  error?: Failure;
  /** Tags a sweep that ran out of budget had read: next time they come in
   * the first query, so the next sweep gets further. */
  watch?: string[];
}
export interface State {
  repos: Record<string, RepoState>;
  /** The pinned tag per repository, read from REPO's main, and the git tree
   * of versions/ they were read from (read again only when it changes). */
  pins: { oid: string | null; tags: Record<string, string | null>; error?: Failure };
  /** The sweep as a whole: the first query failing, or a back-off. */
  poll: Backoff;
  dispatch: Backoff & { pending: boolean };
  /** The version that last wrote the state. */
  deployed: string | null;
  /** The version whose sweep last read GitHub with no query failing: a
   * new deployment counts as healthy only once this names it. */
  polledBy?: string | null;
  /** When the key was last written: KV write health (the heartbeat). */
  written: string | null;
  /** The timed sends, by workflow file (sendTimed). Not under `dispatch`,
   * which a successful update dispatch replaces. */
  timed?: Record<string, Timed>;
}
/** A timed workflow: its last successful send, and its failure and back-off. */
export interface Timed { sent?: string; error?: Failure; retryAt?: string }
const empty = (): State => ({ repos: {}, pins: { oid: null, tags: {} }, poll: {}, dispatch: { pending: false }, deployed: null, polledBy: null, written: null });

export function load(raw: string | null): State {
  try {
    const s = raw ? JSON.parse(raw) : null;
    const ok = s && typeof s === "object" && s.repos && s.pins?.tags && s.poll && s.dispatch;
    return ok ? s : empty();
  } catch {
    return empty();
  }
}

// A stored retry time beyond MAX_BACKOFF_MS (saved before the cap, or edited
// by hand) is ignored, so the watcher can't stay silent for good.
const later = (at: string | undefined, now: number) => {
  const t = at === undefined ? NaN : Date.parse(at);
  return t > now && t <= now + MAX_BACKOFF_MS;
};

const repoAt = (env: Env) => {
  const [owner, name] = env.REPO.split("/");
  return `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})`;
};
const pinsTreeQuery = (env: Env) => `pins: ${repoAt(env)} { object(expression: "main:versions") { oid } }`;
const pinsBlobQuery = (env: Env, oid: string) =>
  `pins: ${repoAt(env)} { object(oid: ${JSON.stringify(oid)}) { ... on Tree { entries { name object { ... on Blob { text } } } } } }`;

/** The pinned tag per repository from versions/<repo>.json, or null where
 * there is no pin file or no usable tag in it (check-pins catches that). */
export function pinsFromTree(tree: any): Record<string, string | null> | null {
  if (!Array.isArray(tree?.entries)) return null;
  const out: Record<string, string | null> = {};
  for (const source of SOURCES) {
    const text = tree.entries.find((e: any) => e?.name === `${source.repo}.json`)?.object?.text;
    let tag: unknown = null;
    try {
      tag = typeof text === "string" ? JSON.parse(text)?.tag : null;
    } catch {
      tag = null;
    }
    out[source.repo] = typeof tag === "string" && versionOf(source, tag) !== null ? tag : null;
  }
  return out;
}

/** One repository's reading during a sweep. */
interface Work {
  source: Source;
  i: number;
  /** Its releases as listed so far, newest first, without assets. */
  list: Release[];
  more: { hasNextPage: boolean; endCursor: string | null };
  pages: number;
  /** Assets read by tag: null when the release didn't come back. */
  assets: Map<string, ReleaseAsset[] | null>;
  /** The draft and prerelease flags of the releases read by tag. */
  flags: Map<string, boolean>;
  failed: SourceError | null;
}

type Need = { page: string } | { tags: string[] } | { failed: SourceError } | { done: Selection };

const listed = (n: any): Release | null =>
  n && typeof n.tagName === "string"
    ? { id: n.databaseId, tag: n.tagName, draft: Boolean(n.isDraft), prerelease: Boolean(n.isPrerelease), publishedAt: n.publishedAt ?? null, assets: [], assetsComplete: false }
    : null;

/** Add a page of releases (a release created between two pages can show up
 * twice: it's kept once). */
function addPage(w: Work, releases: any): void {
  const nodes = releases?.nodes;
  if (!Array.isArray(nodes)) {
    w.failed = new SourceError("parse", `${w.source.repo}: no release list`);
    return;
  }
  for (const n of nodes) {
    const r = listed(n);
    if (!r) {
      w.failed = new SourceError("parse", `${w.source.repo}: a release without a tag`);
      return;
    }
    if (!w.list.some((x) => x.tag === r.tag)) w.list.push(r);
  }
  w.more = { hasNextPage: Boolean(releases?.pageInfo?.hasNextPage), endCursor: releases?.pageInfo?.endCursor ?? null };
  w.pages++;
  // More, with no way to them, before the window's end: the window can't be
  // read in full. (At the end no next page is asked for.)
  if (w.more.hasNextPage && !w.more.endCursor && w.pages < RELEASE_PAGES) w.failed = new SourceError("parse", `${w.source.repo}: more releases, but no cursor to them`);
}

/** Whether the window is read: RELEASE_PAGES pages. */
const outOfPages = (w: Work) => w.pages >= RELEASE_PAGES;

/** The pin, read by tag: gone (no release), or a draft or prerelease
 * again. Either way main follows back, as for a pin listed pulled. */
const pinOut = (w: Work, pin: string | null) =>
  !!pin && w.assets.has(pin) && (w.assets.get(pin) === null || w.flags.get(pin) === true);

/** What a repository still needs this sweep before it's decided. */
function next(w: Work, pin: string | null): Need {
  if (w.failed) return { failed: w.failed };
  // The pin gone or pulled, as its by-tag read says.
  const pinGone = pinOut(w, pin);
  if (!farEnough(w.source, w.list, pin, false, pinGone) && w.more.hasNextPage) {
    if (!outOfPages(w)) return { page: w.more.endCursor! };
    // Out of pages: a pin not listed is looked up by tag first; then a
    // pulled or gone pin lets a lower release in the window stand in.
    if (pin && versionOf(w.source, pin) && !w.assets.has(pin)) return { tags: [pin] };
    if (!farEnough(w.source, w.list, pin, false, pinGone, true)) {
      return { failed: new SourceError("truncated", `${w.source.repo}: ${w.pages} pages of releases hold no published release besides the pin ${pin}, or don't reach it`) };
    }
  }
  // Releases whose assets weren't read count as not read in full, so they
  // are never the candidate: every one above the highest eligible is read
  // first (select() lists them as waiting).
  const releases = w.list.map((r) => {
    const a = w.assets.get(r.tag);
    return a ? { ...r, assets: a, assetsComplete: true } : r;
  });
  const sel = select(w.source, releases);
  const unread = sel.waiting.map((x) => x.release.tag).filter((t) => !w.assets.has(t));
  let tags = unread;
  if (pin && versionOf(w.source, pin) && !w.assets.has(pin)) {
    // The pin first, with only the tags above it: when it's eligible the
    // ones below it don't matter.
    const pv = versionOf(w.source, pin)!;
    tags = [pin, ...unread.filter((t) => t !== pin && compareVersions(versionOf(w.source, t)!, pv) > 0)];
  }
  if (tags.length) return { tags: tags.slice(0, TAGS_PER_ROUND) };
  const gone = sel.waiting.find((x) => w.assets.get(x.release.tag) === null);
  if (gone) return { failed: new SourceError("parse", `${w.source.repo}: ${gone.release.tag} is listed but its release didn't come back`) };
  // The assets read now show whether the window holds an eligible release
  // for a pulled pin (the asset-blind rule above took any published one).
  // Only at the window's end: before it, the first check paged on.
  if (!farEnough(w.source, releases, pin, true, pinGone, outOfPages(w)) && w.more.hasNextPage) {
    return { failed: new SourceError("truncated", `${w.source.repo}: ${w.pages} pages of releases hold no eligible release for the pulled pin ${pin}`) };
  }
  return { done: sel };
}

/** The tags whose assets still matter for a repository, from what's read so
 * far: the pin, the highest eligible release and the ones waiting above it. */
function relevant(w: Work, pin: string | null): Set<string> {
  const releases = w.list.map((r) => {
    const a = w.assets.get(r.tag);
    return a ? { ...r, assets: a, assetsComplete: true } : r;
  });
  const sel = select(w.source, releases);
  return new Set([...(pin ? [pin] : []), ...(sel.candidate ? [sel.candidate.tag] : []), ...sel.waiting.map((x) => x.release.tag)]);
}

/** The tags whose assets the first query reads for a repository. */
function windowOf(source: Source, s: RepoState | undefined, pin: string | null): string[] {
  const tags = [pin, s?.pinned?.tag, s?.eligible?.tag, ...Object.keys(s?.waiting ?? {}), ...(s?.watch ?? [])];
  return [...new Set(tags.filter((t): t is string => typeof t === "string" && versionOf(source, t) !== null))];
}

function readAssets(w: Work, data: any, aliases: [string, string][]): void {
  for (const [alias, tag] of aliases) {
    const node = data?.[alias];
    // No repository in the reply (an error, NOT_FOUND) says nothing about
    // the tag: the repository stays unknown. Only `release: null` is a
    // release that's gone.
    if (!node || typeof node !== "object") {
      if (!w.failed) w.failed = new SourceError("parse", `${w.source.repo}: the lookup of ${tag} came back without the repository`);
      continue;
    }
    w.assets.set(tag, assetsFromGraphql(node.release));
    if (node?.release) w.flags.set(tag, Boolean(node.release.isDraft) || Boolean(node.release.isPrerelease));
  }
}

/** The workflows the watcher starts about hourly, as GitHub's schedule
 * trigger drops runs (pages.yml and health.yml keep theirs as a fallback). */
export const TIMED: string[] = ["pages.yml", "health.yml"];
/** A timed workflow is due this long after its last successful send. */
export const TIMED_EVERY_MS = 50 * 60_000;
/** No timed sends while the key's last write is older than this, or there
 * is none: writes may be failing (the account's quota, an outage), when a
 * send couldn't be saved and would repeat every minute; or the Worker
 * wasn't running for a while, which costs one heartbeat. A new key sends at
 * its next writing run after the first write. */
export const TIMED_STALE_MS = 20 * 60_000;

/** The timed sends, in a sweep that writes anyway, so they cost no KV
 * writes: each due workflow is dispatched on main. A failure keeps the
 * workflow due for the next writing sweep; a rate limit (with no retry
 * time: one heartbeat, from the sweep's time) holds back every timed
 * workflow, due or not, as they share the token. Nothing is sent while the
 * update dispatch is rate limited, for the same reason. Back-offs here
 * don't double as the update dispatch's do: they're saved with the write
 * they ride on. */
async function sendTimed(state: State, env: Env, t: number, iso: string, f: Fetch): Promise<void> {
  const timed = (state.timed ??= {});
  let limited: number | null = null;
  for (const name of TIMED) {
    if (limited !== null) break;
    const s = (timed[name] ??= {});
    const since = t - Date.parse(s.sent ?? "");
    if (since >= 0 && since < TIMED_EVERY_MS) continue;
    if (later(s.retryAt, t)) continue;
    try {
      const res = await request(f, `https://api.github.com/repos/${env.REPO}/actions/workflows/${name}/dispatches`, t, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      }, true);
      await res.body?.cancel();
      timed[name] = { sent: iso };
    } catch (e: any) {
      const err = asError(e, "network");
      if (s.error?.kind !== err.kind) s.error = { kind: err.kind, message: err.message.slice(0, 300), since: s.error?.since ?? iso };
      if (err.kind === "rate-limit") limited = err.retryAt ?? t + HEARTBEAT_MS;
      else delete s.retryAt;
    }
  }
  // A rate limit holds back every timed workflow, due or not, sent before
  // it in this run or after; a later back-off of its own is kept.
  if (limited !== null) {
    for (const name of TIMED) {
      const s = (timed[name] ??= {});
      if (!(later(s.retryAt, t) && Date.parse(s.retryAt!) > limited)) s.retryAt = new Date(limited).toISOString();
    }
  }
}

/** One sweep. Returns the state, and whether it was written. */
export async function run(env: Env, now: Date, f: Fetch = fetch): Promise<{ state: State; written: boolean; dispatched: boolean }> {
  const t = now.getTime();
  const iso = now.toISOString();
  let readFailed = false;
  let state: State;
  try {
    state = load(await env.STATE.get(KEY));
  } catch (e: any) {
    console.error(`KV read failed: ${e?.message ?? e}`);
    readFailed = true;
    state = empty();
  }
  let write = false;
  let changed = false;
  let polled = false;
  // The back-offs as saved, before this sweep changes them.
  const saved = { poll: { ...state.poll }, dispatch: { ...state.dispatch } };

  // Errors are saved with the heartbeat, never on their own, so errors that
  // come and go can't spend the write quota. `since` is when this run of
  // failures began, whatever its kinds.
  const fail = (s: Backoff, err: SourceError) => {
    if (s.error?.kind !== err.kind || s.error.message !== err.message) {
      s.error = { kind: err.kind, message: err.message.slice(0, 300), since: s.error?.since ?? iso };
    }
  };
  const backOff = (s: Backoff, before: Backoff, err: SourceError) => {
    // Asked, so any stored retry time is over (or was past the cap).
    if (!err.retryAt) {
      delete s.retryAt;
      delete s.retryMs;
      return;
    }
    // Following on from a saved back-off (only success clears it): at
    // least twice as long as that one.
    const prev = before.retryAt && typeof before.retryMs === "number" && before.retryMs > 0 ? before.retryMs : 0;
    const ms = Math.min(MAX_BACKOFF_MS, Math.max(err.retryAt - t, 2 * prev));
    s.retryAt = new Date(t + ms).toISOString();
    s.retryMs = ms;
    // One that would skip the next minute's sweep is saved now, or that
    // sweep (a fresh isolate) would ask through it; a shorter one is over
    // by then. It's always a new one: nothing asks while a saved one lasts.
    if (ms > 60_000) write = true;
  };

  if (!later(state.poll.retryAt, t)) await sweep();

  async function sweep() {
    const works: Work[] = SOURCES.map((source, i) => ({
      source, i, list: [], more: { hasNextPage: false, endCursor: null }, pages: 0, assets: new Map(), flags: new Map(), failed: null,
    }));
    const pinOf = (w: Work) => state.pins.tags[w.source.repo] ?? null;

    // The first query: every list's first page, the pins' tree, and each
    // window's assets.
    const parts = [pinsTreeQuery(env)];
    const first = new Map<Work, [string, string][]>();
    for (const w of works) {
      parts.push(repoQuery(`r${w.i}`, w.source.repo, null));
      const aliases = windowOf(w.source, state.repos[w.source.repo], pinOf(w)).map((tag, j): [string, string] => [`r${w.i}t${j}`, tag]);
      for (const [alias, tag] of aliases) parts.push(assetsQuery(alias, w.source.repo, tag, requiredNames(w.source, versionOf(w.source, tag)!)));
      first.set(w, aliases);
    }
    let reply: { data: any; notFound: Set<string> };
    try {
      reply = await graphql(f, env, t, parts.join("\n"));
    } catch (e: any) {
      const err = asError(e);
      fail(state.poll, err);
      backOff(state.poll, saved.poll, err);
      return;
    }
    delete state.poll.error;
    delete state.poll.retryAt;
    delete state.poll.retryMs;
    for (const w of works) {
      if (reply.notFound.has(`r${w.i}`)) w.failed = new SourceError("not-found", `${w.source.repo}: not found (renamed or deleted?)`);
      else if (!reply.data[`r${w.i}`]) w.failed = new SourceError("parse", `${w.source.repo}: no data`);
      else {
        addPage(w, reply.data[`r${w.i}`].releases);
        readAssets(w, reply.data, first.get(w)!);
      }
    }
    let newPins: string | null = null;
    const oid = reply.data.pins?.object?.oid;
    if (reply.notFound.has("pins") || typeof oid !== "string") {
      fail(state.pins, new SourceError(reply.notFound.has("pins") ? "not-found" : "parse", `${env.REPO}: versions/ on main not read`));
    } else if (oid !== state.pins.oid) {
      newPins = oid;
    } else {
      delete state.pins.error;
    }

    // Follow-ups, each for every repository that needs one, within the
    // budget. The pins come alone, first: what else is needed depends on them.
    let stop: SourceError | null = null;
    for (let used = 0, round = 0; ; round++) {
      const parts: string[] = [];
      const asked = new Map<Work, [string, string][]>();
      const paged = new Set<Work>();
      if (newPins) {
        parts.push(pinsBlobQuery(env, newPins));
      } else {
        for (const w of works) {
          const need = next(w, pinOf(w));
          if ("page" in need) {
            parts.push(repoQuery(`r${w.i}`, w.source.repo, need.page));
            paged.add(w);
          } else if ("tags" in need) {
            const aliases = need.tags.map((tag, j): [string, string] => [`r${w.i}f${round}t${j}`, tag]);
            for (const [alias, tag] of aliases) parts.push(assetsQuery(alias, w.source.repo, tag, requiredNames(w.source, versionOf(w.source, tag)!)));
            asked.set(w, aliases);
          }
        }
      }
      if (!parts.length) break;
      if (used >= ASSET_BUDGET) {
        stop = new SourceError("budget", `not read in full: more follow-up queries than a sweep's budget (${ASSET_BUDGET})`);
        break;
      }
      used++;
      let more: { data: any; notFound: Set<string> };
      try {
        more = await graphql(f, env, t, parts.join("\n"));
      } catch (e: any) {
        stop = asError(e);
        backOff(state.poll, saved.poll, stop);
        if (newPins) fail(state.pins, stop);
        break;
      }
      if (newPins) {
        const tags = more.notFound.has("pins") ? null : pinsFromTree(more.data.pins?.object);
        if (tags) {
          state.pins = { oid: newPins, tags };
          write = true; // the pins moved: saved, not dispatched
        } else {
          fail(state.pins, new SourceError("parse", `${env.REPO}: versions/ at ${newPins} not read`));
        }
        newPins = null; // either way: with the old pins if they couldn't be read
        continue;
      }
      for (const w of paged) {
        if (more.notFound.has(`r${w.i}`) || !more.data[`r${w.i}`]) w.failed = new SourceError("parse", `${w.source.repo}: a further page of releases didn't come back`);
        else addPage(w, more.data[`r${w.i}`].releases);
      }
      for (const [w, aliases] of asked) readAssets(w, more.data, aliases);
    }

    // Every query this sweep sent was answered (running out of budget isn't
    // a failure): the deployment can read GitHub.
    if (!stop || stop.kind === "budget") polled = true;
    for (const w of works) {
      const need = next(w, pinOf(w));
      const repo = w.source.repo;
      if ("done" in need) {
        settle(w, pinOf(w), need.done);
        continue;
      }
      // Not read in full: unknown, so the previous state stands; the error
      // waits for the heartbeat. What was read is remembered.
      const err = "failed" in need ? need.failed : stop ?? new SourceError("budget", `${repo}: not read in full`);
      const s = (state.repos[repo] ??= { pinned: null, eligible: null, waiting: {}, read: null });
      fail(s, new SourceError(err.kind, err.message.startsWith(repo) ? err.message : `${repo}: ${err.message}`));
      // Only from a list read far enough to judge which tags still matter:
      // before that no follow-up read a tag, and the old list stands.
      const p = pinOf(w);
      const gone = pinOut(w, p);
      if (w.failed || (!farEnough(w.source, w.list, p, false, gone, outOfPages(w)) && w.more.hasNextPage)) continue;
      const window = windowOf(w.source, { ...s, watch: [] }, pinOf(w));
      const keep = relevant(w, pinOf(w));
      const byVersion = (a: string, b: string) => compareVersions(versionOf(w.source, b)!, versionOf(w.source, a)!);
      // Tags no longer listed, or now below the highest eligible, are dropped.
      const watch = [...w.assets.keys()].filter((tag) => keep.has(tag) && !window.includes(tag)).sort(byVersion).slice(0, WATCH_MAX);
      if (watch.join(" ") !== (s.watch ?? []).join(" ")) {
        if (watch.length) s.watch = watch;
        else delete s.watch;
        write = true;
      }
    }
  }

  /** A repository read in full: its new state, and whether it changed. */
  function settle(w: Work, pin: string | null, sel: Selection) {
    const source = w.source;
    const old = state.repos[source.repo] as RepoState | undefined;
    const pinAssets = pin ? w.assets.get(pin) : null;
    const listedPin = pin ? w.list.find((r) => r.tag === pin) : undefined;
    const pinned = pin ? {
      tag: pin,
      fingerprint: pinAssets ? fingerprint(source, { tag: pin, assets: pinAssets } as Release) : null,
      // Gone (its assets didn't come back), or a draft or prerelease again
      // (as listed, or as read by tag past the listing).
      pulled: !pinAssets || (listedPin ? listedPin.draft || listedPin.prerelease : w.flags.get(pin) ?? false),
    } : null;
    const c = sel.candidate;
    const fp = c ? fingerprint(source, c) : null;
    // A same-tag re-upload is a new input: first seen now.
    const eligible = c
      ? { tag: c.tag, version: versionOf(source, c.tag)!, fingerprint: fp!, firstSeen: old?.eligible?.tag === c.tag && old.eligible.fingerprint === fp ? old.eligible.firstSeen : iso }
      : null;
    const waiting: RepoState["waiting"] = {};
    for (const { release } of sel.waiting) waiting[release.tag] = { firstSeen: old?.waiting?.[release.tag]?.firstSeen ?? iso };

    let change = !old || old.eligible?.tag !== eligible?.tag || old.eligible?.fingerprint !== eligible?.fingerprint;
    // The pinned release's fingerprint against what was last seen for that
    // tag, as the pin or as the eligible release (the pin may just have
    // moved onto it). A pin moved onto a tag never seen has nothing to
    // compare with.
    const before = pinned && (old?.pinned?.tag === pinned.tag ? old.pinned.fingerprint : old?.eligible?.tag === pinned.tag ? old.eligible.fingerprint : undefined);
    if (pinned && before !== undefined && before !== pinned.fingerprint) change = true;
    // The same pin pulled, or back: the resolver may now move main (a
    // downgrade, or back up), so it's worth a dispatch.
    if (pinned && old?.pinned?.tag === pinned.tag && (old.pinned.pulled ?? false) !== pinned.pulled) change = true;
    const keys = (o: object) => Object.keys(o).sort().join(" ");
    if (keys(old?.waiting ?? {}) !== keys(waiting)) change = true;
    if (change) changed = true;
    if (change || old?.pinned?.tag !== pinned?.tag || old?.pinned?.fingerprint !== pinned?.fingerprint || (old?.pinned?.pulled ?? false) !== (pinned?.pulled ?? false) || old?.watch?.length) write = true;
    state.repos[source.repo] = { pinned, eligible, waiting, read: iso };
  }

  if (changed || readFailed) state.dispatch.pending = true;
  const d = state.dispatch;
  let dispatched = false;
  let dispatchLimitedNow = false;
  if (d.pending && !later(d.retryAt, t)) {
    try {
      const res = await request(f, `https://api.github.com/repos/${env.REPO}/actions/workflows/update.yml/dispatches`, t, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      await res.body?.cancel();
      state.dispatch = { pending: false };
      dispatched = true;
      write = true;
    } catch (e: any) {
      const err = asError(e, "network");
      if (d.error?.kind !== err.kind) d.error = { kind: err.kind, message: err.message, since: d.error?.since ?? iso };
      if (err.kind === "rate-limit") dispatchLimitedNow = true;
      backOff(d, saved.dispatch, err);
    }
  }
  const deployed = env.CF_VERSION?.id ?? null;
  if (state.deployed !== deployed) {
    state.deployed = deployed;
    write = true;
  }
  if (polled && state.polledBy !== deployed) {
    state.polledBy = deployed;
    write = true;
  }
  if (!(t - Date.parse(state.written ?? "") < HEARTBEAT_MS)) write = true;
  if (readFailed || !write) return { state, written: false, dispatched };
  // Riding on this write, after one saved no more than TIMED_STALE_MS ago.
  // Not while the update dispatch is rate limited (in this run, or by a
  // saved back-off): they share the token.
  const dispatchLimited = dispatchLimitedNow || (state.dispatch.error?.kind === "rate-limit" && later(state.dispatch.retryAt, t));
  if (t - Date.parse(state.written ?? "") <= TIMED_STALE_MS && !dispatchLimited) await sendTimed(state, env, t, iso, f);
  state.written = iso;
  try {
    await env.STATE.put(KEY, JSON.stringify(state));
  } catch (e: any) {
    // Polling and dispatching go on; the stale heartbeat makes the backstop
    // report KV writes failing (or the watcher stopped).
    console.error(`KV write failed: ${e?.message ?? e}`);
    return { state, written: false, dispatched };
  }
  return { state, written: true, dispatched };
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GET /health with the bearer token: the deployed version and the state
 * (health.ts reads it for the backstop). Anything else is a 404 that reads
 * no KV, so nobody else can spend the read quota. */
export async function health(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/health" || !env.HEALTH_TOKEN || !same(auth, `Bearer ${env.HEALTH_TOKEN}`)) {
    return new Response("not found", { status: 404 });
  }
  let raw: string | null;
  try {
    raw = await env.STATE.get(KEY);
  } catch (e: any) {
    return Response.json({ deployed: env.CF_VERSION?.id ?? null, state: null, error: `KV read failed: ${e?.message ?? e}` }, { status: 503 });
  }
  return Response.json({ deployed: env.CF_VERSION?.id ?? null, state: raw ? load(raw) : null });
}
