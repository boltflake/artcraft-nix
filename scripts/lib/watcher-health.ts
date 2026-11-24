// What the status page takes from the watcher's /health reply: for each
// repository, the version it last read as upstream's highest eligible
// release, and when it first saw it. Kept apart from the live view
// (status-live.ts) so a change to the watcher's reply changes only this file.
//
// The reply is the watcher's state (watcher/src/watcher.ts State), read the
// way the hourly backstop reads it (watcher/src/health.ts readHealth):
//   - the whole reply counts only while its KV heartbeat (`state.written`)
//     is fresh (STALE_MS) and no more than SKEW_MS ahead of our clock;
//   - a repository counts only while its last full read (`read`) is fresh
//     and it has no error; its version is `eligible.version` (null: no
//     eligible release, so "not checked") and `eligible.firstSeen`.
// "Checked" is the oldest full read among the repositories that count, or
// the heartbeat when none does.
import { SOURCES } from "../../shared/sources.ts";
import { readHealth, STALE_MS } from "../../watcher/src/health.ts";

export { STALE_MS };
/** A heartbeat may run this far ahead of our clock and still count. */
export const SKEW_MS = 5 * 60_000;

const VERSION = /^\d+\.\d+\.\d+$/;

export interface Upstream {
  /** Repository -> upstream's highest eligible version, read without error. */
  versions: Map<string, string>;
  /** Repository -> when the watcher first saw that version. */
  firstSeen: Map<string, string>;
  /** What "checked against upstream" says. */
  checked: string;
  /** Repositories whose pinned release the watcher found pulled, with that
   * pin's tag (it counts only for a page whose pin is that tag): gone (its
   * fingerprint null), a draft or a prerelease again. A pin that only lost
   * some files isn't. */
  pinGone: Map<string, string>;
}

/** The usable reply, or null when there is none. */
export function upstream(health: any, now: Date): Upstream | null {
  const h = readHealth(health, now);
  if (!h || h.writesStale || Date.parse(h.written!) > now.getTime() + SKEW_MS) return null;
  const versions = new Map<string, string>(), firstSeen = new Map<string, string>(), reads: number[] = [];
  const pinGone = new Map<string, string>();
  for (const { repo } of SOURCES) {
    const r = h.repos[repo];
    if (!r || r.stale || r.error) continue;
    const pinned = health.state.repos?.[repo]?.pinned;
    if (pinned && typeof pinned.tag === "string" && (pinned.fingerprint === null || pinned.pulled === true)) pinGone.set(repo, pinned.tag);
    const e = health.state.repos?.[repo]?.eligible;
    if (typeof e?.version !== "string" || !VERSION.test(e.version)) continue;
    reads.push(Date.parse(r.read!));
    versions.set(repo, e.version);
    const seen = Date.parse(typeof e.firstSeen === "string" ? e.firstSeen : "");
    if (Number.isFinite(seen)) firstSeen.set(repo, new Date(seen).toISOString());
  }
  const checked = new Date(reads.length ? Math.min(...reads) : Date.parse(h.written!)).toISOString();
  return { versions, firstSeen, checked, pinGone };
}
