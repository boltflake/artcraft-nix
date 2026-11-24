// The hourly backstop's reading of the watcher (health.yml), as in
// t3code-nix's health.ts: /health into issues.
//
//   node health.ts HEALTH_JSON|- [ERROR]
//
// HEALTH_JSON is the /health reply (curl's output), or "-" with ERROR when
// it couldn't be fetched. Prints {observations}:
//   watcher-stalled  KV writes stale (writes failing, or the watcher
//                    stopped), a repository's polling stale, or a failure
//                    stuck for 6 hours (a timed send's included)
//   watcher-auth     GitHub refuses the watcher's token (reading, the update
//                    dispatch, or the hourly start of pages.yml or health.yml)
//   watcher-healthy  neither of those (three in a row close them)
//   update-lag       a repository's eligible release seen by the watcher an
//                    hour ago or more and still not on main (per repository;
//                    held releases excepted: they have issues of their own)
//   lag-ok           the repository is caught up, or held
import { readFileSync } from "node:fs";
import { compareVersions, SOURCES } from "../../shared/sources.ts";
import { readHealth } from "../../watcher/src/health.ts";
import { currentPin, type Pin } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";
import { readHeld } from "./held.ts";

export const LAG_MS = 60 * 60_000;

export function assess(body: any, error: string | null, pins: Record<string, Pin | null>, held: Set<string>, now: Date): Observation[] {
  if (error || !body) return [obs("watcher-stalled", null, null, `/health didn't answer: ${error ?? "no reply"}`)];
  const h = readHealth(body, now);
  if (!h) return [obs("watcher-stalled", null, null, "/health's reply isn't one the backstop can read")];
  const out: Observation[] = [];
  const problems: string[] = [];
  if (h.writesStale) problems.push(`the watcher's KV writes are stale (last ${h.written ?? "never"}): writes failing, or the watcher stopped`);
  for (const [repo, r] of Object.entries(h.repos)) if (r.stale) problems.push(`${repo}: last read in full ${r.read ?? "never"}${r.error ? ` (${r.error.kind}: ${r.error.message})` : ""}`);
  for (const s of h.stuck) problems.push(`${s}: failing for more than 6 hours`);
  if (h.auth.length) out.push(obs("watcher-auth", null, null, h.auth.join("\n")));
  if (problems.length) out.push(obs("watcher-stalled", null, null, problems.join("\n")));
  // Healthy only with no auth error either, as in t3code-nix: a reading
  // with an auth error isn't a healthy one.
  if (!problems.length && !h.auth.length) out.push(obs("watcher-healthy", null));
  // update-lag from the state: only when the writes are fresh, and per
  // repository only from a fresh read without an error (a stale or failing
  // repository is watcher-stalled's business, and says nothing either way).
  if (!h.writesStale) {
    for (const { repo } of SOURCES) {
      const r = h.repos[repo];
      const pin = pins[repo];
      if (!pin || !r || r.stale || r.error) continue;
      const e = body.state.repos?.[repo]?.eligible;
      if (!e?.version) {
        // No eligible release upstream: nothing to lag behind.
        out.push(obs("lag-ok", repo, pin.version));
        continue;
      }
      const seen = Date.parse(e.firstSeen ?? "");
      // Lagging means main should have moved: to a higher release, or back
      // from this very pin seen pulled. A lower eligible release while the
      // pin stands (it only lost files) is no lag: main keeps the pin.
      const pinned = body.state.repos?.[repo]?.pinned;
      const due = compareVersions(e.version, pin.version) > 0 || (pinned?.pulled === true && pinned?.tag === pin.tag);
      if (due && !held.has(`${repo}\0${e.version}`) && Number.isFinite(seen) && now.getTime() - seen >= LAG_MS) {
        out.push(obs("update-lag", repo, e.version, `the watcher saw ${repo} ${e.version} at ${e.firstSeen}; main still has ${pin.version}`));
      } else {
        out.push(obs("lag-ok", repo, pin.version));
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const [file, error] = process.argv.slice(2);
  let body: any = null;
  let err: string | null = error ?? null;
  if (file && file !== "-") {
    try { body = JSON.parse(readFileSync(file, "utf8")); } catch (e: any) { err = `not JSON: ${e.message}`; }
  }
  const pins = Object.fromEntries(SOURCES.map((s) => [s.repo, currentPin(s.repo)]));
  const heldFile = process.env.HELD_JSON;
  // held.ts's file: {holds, waiting} (an array: holds only). Matched by
  // version: the watcher's asset IDs are GraphQL node IDs, so its
  // fingerprints can't be compared with the holds' (a repaired upload under a
  // held version stays exempt here; the update run verifies it afresh).
  const holds = readHeld(heldFile).holds;
  const held = new Set<string>(holds.map((h: any) => `${h.repo}\0${h.version}`));
  console.log(JSON.stringify({ observations: assess(body, err, pins, held, new Date()) }, null, 2));
}
