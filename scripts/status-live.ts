// The status page's live view: each package's state, from the watcher's
// /health (scripts/lib/watcher-health.ts), the unfinished update runs'
// candidates and the open issues. Pure: the reads happen in pages.yml (the
// runs and issues in a job without secrets, see scripts/ci/status-reads.ts).
// As in t3code-nix, per package: inputs, holds and issues are per
// repository release, so a companion shares its app's state, except when
// the pin marks it unavailable.
//
// First match wins: unavailable; testing; not checked; then by upstream's
// version against main's: the same (held when an issue holds main's own
// version, a same-tag re-upload that failed; waiting; current), lower
// (held when an issue holds the lower one, else pulled: main follows back
// after the tests), higher (held, found). A run is a fact and an issue is
// history, so testing comes before held. A candidate tests a repository
// when it moves it to another version, or to main's version with other
// files (its fingerprint differs from main's pin's).
import { compareVersions, sourceOf, releasePage } from "../shared/sources.ts";
import type { Pin } from "./lib/util.ts";
import { upstream } from "./lib/watcher-health.ts";
import { pinFingerprint } from "./update.ts";

export { SKEW_MS, STALE_MS } from "./lib/watcher-health.ts";

/** This repository, for links. */
export const REPO = "boltflake/artcraft-nix";

/** An unfinished update run and what its candidate tests (validated). */
export interface Run {
  id: number;
  /** When it was created: with several runs testing a repository, the newest wins. */
  created: string;
  /** GitHub's status for it: "requested" when just made, "pending" while
   * it waits behind another run in the update group (it has no jobs yet);
   * then "in_progress", or "queued" whenever one of its jobs waits for a
   * runner, or "waiting" for an approval. A Run built without one (in
   * tests) counts as started. */
  status?: string;
  /** The repositories the candidate moves, to which version, and the
   * files' fingerprint (scripts/update.ts pinFingerprint) when known. */
  inputs: { name: string; version: string; fingerprint?: string }[];
}
/** An open artcraft-nix issue: its number, kind, and the repository and
 * version it is about (null: not about one), from the body's marker. */
export interface OpenIssue {
  number: number;
  kind: string;
  repo: string | null;
  version: string | null;
  /** The issue's scope (a system, or "stable" for the NixOS-stable
   * snapshot); null for main's. */
  channel?: string | null;
  /** An issue for the record (an integrity issue with no hold). */
  record?: true;
}
export type StateName = "current" | "testing" | "held" | "unavailable" | "waiting" | "found" | "pulled" | "not-checked";
export interface PinState {
  state: StateName;
  /** The version being tested, held, waited for, found, or (pulled) the
   * one main follows back to. */
  version?: string;
  /** Held, waiting and pulled: why, in a few plain words. Testing and held:
   * set when it is main's own version with other files. */
  reason?: string;
  /** Pulled with no eligible release left: the pin stays where it is. */
  stays?: boolean;
  /** Found and pulled: what the version is waiting for (see `waitFor`). */
  wait?: string;
  /** The state's own time: the run's creation (testing), the watcher's
   * first sight of the version (held, found, pulled), the marker's
   * (unavailable). */
  since?: string;
  /** The run (testing), the issue (held, waiting, unavailable) or upstream's
   * release notes (found, pulled). */
  link?: string;
}
export interface Live {
  /** The oldest heartbeat of the watcher's usable keys. */
  checked: string;
  states: Record<string, PinState>;
}

/** The kinds that hold a release, most specific first. */
export const HOLDS = ["test-failed", "combination-failed", "integrity"];
// Why an issue explains a version, most specific first, in words.
const KIND_ORDER = [...HOLDS, "no-match", "resolve-failed"];
const WORDS: Record<string, string> = {
  "test-failed": "tests failed",
  "combination-failed": "failed together with another update",
  integrity: "files or signature don't verify",
  "no-match": "no matching release",
  "resolve-failed": "couldn't read upstream",
  "env-broken": "build environment broken",
};
const words = (kind: string) => WORDS[kind] ?? kind.replace(/-/g, " ");

/** The issue that explains `version` of `repo` being held, picked the same
 * way every time; or null. */
export function explaining(repo: string, version: string, issues: OpenIssue[]): OpenIssue | null {
  const ranked = issues.flatMap((i) => {
    if (i.kind === "env-broken") return [{ ...i, tier: 2 }];
    // Only main's own: the stable snapshot's problems explain nothing here.
    if (i.repo !== repo || !KIND_ORDER.includes(i.kind) || i.channel || i.record) return [];
    if (i.version === version) return [{ ...i, tier: 0 }];
    if (i.kind === "resolve-failed" && i.version === null) return [{ ...i, tier: 1 }];
    return [];
  });
  const order = (k: string) => KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length;
  ranked.sort((a, b) => a.tier - b.tier || order(a.kind) - order(b.kind) || a.number - b.number);
  const best = ranked[0];
  return best ? { number: best.number, kind: best.kind, repo: best.repo, version: best.version } : null;
}

/** The open incomplete-release issue for a release above `version`, the
 * highest such; or null. */
export function incomplete(repo: string, version: string, issues: OpenIssue[]): OpenIssue | null {
  const above = issues.filter((i) => i.kind === "incomplete-release" && i.repo === repo && i.version !== null && compareVersions(i.version, version) > 0);
  above.sort((a, b) => compareVersions(b.version!, a.version!) || a.number - b.number);
  return above[0] ?? null;
}

/** Whether a run has started: anything but just made or behind another run.
 * A run with a candidate has resolved, so it has started whatever its status
 * says. */
const started = (r: Run) => (r.status !== "requested" && r.status !== "pending") || r.inputs.length > 0;

/** What a found version is waiting for, given the unfinished update runs
 * (none of which tests it, or it would be testing):
 * - a run waits (GitHub keeps one waiting behind the run in progress, and
 *   it reads upstream afresh): "queued for next run";
 * - a run just made, and none running: "run starting";
 * - the run in progress has a candidate without it, and none waits: "not in
 *   this run";
 * - the run in progress has no candidate we can read: "run in progress";
 * - no run at all: "waiting for the next run" (the hourly backstop starts one). */
export function waitFor(runs: Run[]): string {
  const running = runs.filter(started), waiting = runs.filter((r) => !started(r));
  if (running.length && waiting.length) return "queued for next run";
  if (waiting.length) return "run starting";
  if (running.some((r) => r.inputs.length)) return "not in this run";
  if (running.length) return "run in progress";
  return "waiting for the next run";
}

/** `{since}` for a valid time, normalised; nothing otherwise. */
const since = (at: string | undefined | null): { since?: string } => {
  const t = Date.parse(at ?? "");
  return Number.isFinite(t) ? { since: new Date(t).toISOString() } : {};
};
const issueLink = (repo: string, n: number | null | undefined) => (typeof n === "number" ? { link: `https://github.com/${repo}/issues/${n}` } : {});

/** What a same-tag change says, testing or held. */
export const SAME_TAG = "same version, new files";
/** What a pulled pin says. */
export const PULLED = "upstream pulled this release; main follows back after the tests";
export const PULLED_STAYS = "upstream pulled this release, and no earlier one is eligible; the pin stays";

/** The pin's fingerprint, or null when it can't be taken (a malformed pin). */
function fingerprintOf(pin: Pin): string | null {
  try {
    return pinFingerprint(sourceOf(pin.repo), pin);
  } catch {
    return null;
  }
}

/** Every package's state, or null when the watcher has no usable key. */
export function liveView(pins: Pin[], health: any, runs: Run[], issues: OpenIssue[], repo: string, now: Date): Live | null {
  const up = upstream(health, now);
  if (!up) return null;
  const newestFirst = [...runs].sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id);
  const states: Record<string, PinState> = {};
  for (const pin of pins) {
    const repoState = ((): PinState => {
      const seen = up.versions.get(pin.repo);
      // The newest run whose candidate moves this repository: to another
      // version, or to main's with other files. Same version and no
      // fingerprint (or main's): only a marker moves, nothing to test.
      let own: string | null | undefined;
      const mine = () => (own === undefined ? (own = fingerprintOf(pin)) : own);
      const tested = (r: Run) => r.inputs.find((i) => i.name === pin.repo
        && (i.version !== pin.version || (i.fingerprint !== undefined && mine() !== null && i.fingerprint !== mine())));
      const run = newestFirst.find(tested);
      if (run) {
        const input = tested(run)!;
        return { state: "testing", version: input.version, ...(input.version === pin.version ? { reason: SAME_TAG } : {}),
          ...since(run.created), link: `https://github.com/${repo}/actions/runs/${run.id}` };
      }
      // The watcher saw this very pin pulled (not an earlier pin's sample).
      const pulledPin = up.pinGone?.get(pin.repo) === pin.tag;
      if (seen === undefined && pulledPin) return { state: "pulled", version: pin.version, stays: true, reason: PULLED_STAYS };
      if (seen === undefined) return { state: "not-checked" };
      const firstSeen = since(up.firstSeen.get(pin.repo));
      const order = compareVersions(seen, pin.version);
      if (order === 0) {
        // A hold on main's own version: a same-tag re-upload that failed.
        const hold = issues.filter((i) => i.repo === pin.repo && i.version === pin.version && HOLDS.includes(i.kind) && !i.record && !i.channel)
          .sort((a, b) => HOLDS.indexOf(a.kind) - HOLDS.indexOf(b.kind) || a.number - b.number)[0];
        if (hold) return { state: "held", version: pin.version, reason: `${words(hold.kind)} (${SAME_TAG})`, ...firstSeen, ...issueLink(repo, hold.number) };
        const wait = incomplete(pin.repo, pin.version, issues);
        return wait ? { state: "waiting", version: wait.version!, reason: "upstream's release is incomplete", ...issueLink(repo, wait.number) } : { state: "current" };
      }
      const issue = explaining(pin.repo, seen, issues);
      if (issue) return { state: "held", version: seen, reason: words(issue.kind), ...firstSeen, ...issueLink(repo, issue.number) };
      const notes = releasePage(pin.repo, `${sourceOf(pin.repo).prefix}${seen}`);
      // Upstream's highest eligible release is below the pin. Only a pin
      // confirmed pulled makes main follow back once the release passes the
      // tests; any other pin keeps its place (the resolver doesn't follow
      // back for lost files): its unavailable packages show so, the others
      // current.
      if (order < 0 && !pulledPin) return { state: "current" };
      if (order < 0) return { state: "pulled", version: seen, reason: PULLED, wait: waitFor(runs), ...firstSeen, link: notes };
      return { state: "found", version: seen, wait: waitFor(runs), ...firstSeen, link: notes };
    })();
    for (const pkg of Object.keys(pin.packages)) {
      const gone = pin.unavailable?.packages.includes(pkg);
      // The marker's issue number, or else the open `unavailable` issue for
      // main's pin (the resolver writes the marker before the issue exists).
      const issue = pin.unavailable?.issue ?? issues.find((i) => i.kind === "unavailable" && i.repo === pin.repo && !i.channel)?.number;
      states[pkg] = gone ? { state: "unavailable", version: pin.version, reason: "upstream's files are gone", ...since(pin.unavailable!.since), ...issueLink(repo, issue) } : repoState;
    }
  }
  return { checked: up.checked, states };
}
