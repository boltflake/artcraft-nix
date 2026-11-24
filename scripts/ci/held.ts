// Write the releases held by open issues, for the updater (the resolve job).
//
//   node held.ts OUT_JSON
//
// Reads the repository's artcraft-nix issues and writes {holds: [{repo,
// version, fingerprint}] for every open hold (HOLD_KINDS in issues.ts),
// waiting: [{repo, version}] for every open incomplete-release} (the
// resolver closes each only on evidence for that release), snapshotStuck:
// [tree] (main trees whose NixOS-stable catch-up already failed outright:
// candidate.ts doesn't retry them). Needs GH_TOKEN
// with issues: read.
import { existsSync } from "node:fs";
import { Failed, readJson, writeJson } from "../lib/util.ts";
import { GitHub } from "./gh.ts";
import { heldReleases, stuckTrees, waitingReleases } from "./issues.ts";

export interface HeldFile {
  holds: { repo: string; version: string; fingerprint: string }[];
  waiting: { repo: string; version: string }[];
  snapshotStuck: string[];
}
/** The one reader of held.ts's file, for every script that reads it (an
 * array: an older file of holds only; a missing file: nothing held). */
export function readHeld(path: string | undefined | null): HeldFile {
  if (!path || !existsSync(path)) return { holds: [], waiting: [], snapshotStuck: [] };
  const doc = readJson(path);
  // An existing file must be well formed: a broken one never means "nothing
  // held" (that would let a held release through).
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const holds = Array.isArray(doc) ? doc : doc?.holds;
  const waiting = Array.isArray(doc) ? [] : doc?.waiting ?? [];
  const snapshotStuck = Array.isArray(doc) ? [] : doc?.snapshotStuck ?? [];
  if (!Array.isArray(holds) || !Array.isArray(waiting)
    || !holds.every((h: any) => str(h?.repo) && str(h?.version) && str(h?.fingerprint))
    || !waiting.every((w: any) => str(w?.repo) && str(w?.version))
    || !Array.isArray(snapshotStuck) || !snapshotStuck.every(str)) {
    throw new Failed(`${path} isn't a held-releases file ({holds, waiting, snapshotStuck?})`);
  }
  return { holds, waiting, snapshotStuck };
}

export async function writeHeld(out: string, gh: Pick<GitHub, "issues">) {
  const issues = await gh.issues();
  const held = heldReleases(issues);
  writeJson(out, { holds: held, waiting: waitingReleases(issues), snapshotStuck: stuckTrees(issues) });
  return held;
}

if (import.meta.main) {
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error("usage: held.ts OUT_JSON");
    process.exit(2);
  }
  const held = await writeHeld(out, new GitHub());
  console.log(`${held.length} held release(s)${held.length ? ": " + held.map((h) => `${h.repo} ${h.version}`).join(", ") : ""}`);
}
