// What the hourly backstop (health.yml) reads from the watcher's /health
// reply: kept next to the watcher so the two change together. Pure, so the
// backstop's script and the tests both use it.
//
// Two things are reported separately:
//   - KV write health: `written`, the last successful write, which a
//     working watcher renews at least every 15 minutes (the heartbeat). A
//     stale one means the writes are failing, or the watcher stopped; either
//     way nothing else in the state can be trusted to be current.
//   - Polling freshness per repository: when each was last read in full,
//     and why not since. A repository can go stale on its own (not found,
//     its list truncated, the follow-up budget) while the others are fresh.
import { SOURCES } from "../../shared/sources.ts";
import type { State } from "./watcher.ts";

/** A heartbeat or a repository reading older than this is stale. */
export const STALE_MS = 30 * 60_000;
/** A failure lasting longer than this is stuck. */
export const STUCK_MS = 6 * 60 * 60_000;

export interface HealthReading {
  /** The version the Worker serving /health runs, and the one that last wrote the state. */
  deployed: string | null;
  stateDeployed: string | null;
  /** KV write health. */
  written: string | null;
  writesStale: boolean;
  /** Polling freshness, per repository in SOURCES. */
  repos: Record<string, { read: string | null; stale: boolean; error: { kind: string; message: string; since: string } | null }>;
  /** GitHub refusing the token (the sweep's query or the dispatch). */
  auth: string[];
  /** Failures older than STUCK_MS: the sweep, the pins, the dispatch, or a repository. */
  stuck: string[];
}

/** The /health reply (parsed JSON) as a reading, or null when it isn't one. */
export function readHealth(body: any, now: Date): HealthReading | null {
  const s: State | null = body?.state ?? null;
  if (!body || typeof body !== "object" || !s || typeof s !== "object" || !s.repos || !s.poll || !s.dispatch || !s.pins) return null;
  const t = now.getTime();
  const old = (at: string | null | undefined, ms: number) => {
    const v = Date.parse(at ?? "");
    return !Number.isFinite(v) || t - v > ms;
  };
  const repos: HealthReading["repos"] = {};
  for (const { repo } of SOURCES) {
    const r = s.repos[repo];
    repos[repo] = { read: r?.read ?? null, stale: old(r?.read, STALE_MS), error: r?.error ?? null };
  }
  const failing: (readonly [string, { kind: string; message: string; since: string }])[] = [
    ...(s.poll.error ? [["poll", s.poll.error] as const] : []),
    ...(s.pins.error ? [["pins", s.pins.error] as const] : []),
    ...(s.dispatch.error ? [["dispatch", s.dispatch.error] as const] : []),
    ...Object.entries(repos).flatMap(([repo, r]) => (r.error ? [[repo, r.error] as const] : [])),
  ];
  return {
    deployed: body.deployed ?? null,
    stateDeployed: s.deployed ?? null,
    written: s.written ?? null,
    writesStale: old(s.written, STALE_MS),
    repos,
    auth: failing.filter(([name, e]) => e.kind === "auth" && (name === "poll" || name === "dispatch")).map(([name, e]) => `${name}: ${e.message}`).sort(),
    stuck: failing.filter(([, e]) => old(e.since, STUCK_MS)).map(([name]) => name).sort(),
  };
}
