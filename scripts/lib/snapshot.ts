// The NixOS-stable snapshot (versions/stable/): moving it to a tree's pins,
// and which of its pins lag. Shared by publish.ts and stable.ts (the
// equivalence step).
import { SOURCES } from "../../shared/sources.ts";
import { Failed, git, tryRun } from "./util.ts";

/** The tested tree with versions/stable/ set to its pins. */
export function movedTree(tested: string): string {
  const entries = git("ls-tree", tested, "versions/").split("\n").filter(Boolean);
  const pins = entries.map((l) => /^100644 blob ([0-9a-f]+)\t(versions\/[a-z0-9-]+\.json)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .filter((m) => SOURCES.some((s) => m[2] === `versions/${s.repo}.json`));
  const index = `${process.env.RUNNER_TEMP ?? "/tmp"}/publish-index-${process.pid}`;
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const g = (...args: string[]) => tryRun("git", args, { env });
  g("read-tree", tested);
  g("rm", "-q", "--cached", "-r", "--ignore-unmatch", "versions/stable");
  for (const m of pins) g("update-index", "--add", "--cacheinfo", `100644,${m[1]},${m[2].replace("versions/", "versions/stable/")}`);
  const t = g("write-tree");
  tryRun("rm", ["-f", index]);
  if (t.status !== 0) throw new Failed(`couldn't make the moved tree: ${t.stderr}`);
  // The equivalence: only the snapshot differs.
  const diff = git("diff", "--name-only", tested, t.stdout).split("\n").filter(Boolean);
  const outside = diff.filter((p) => !p.startsWith("versions/stable/"));
  if (outside.length) throw new Failed(`moving the snapshot changed more than versions/stable/: ${outside.join(", ")}`);
  return t.stdout;
}

/** The file-less input of a run that only catches the snapshot up
 * (candidate.ts, kind "catch-up": it takes main's result and is never
 * held, per KINDS). */
export const SNAPSHOT_INPUT = "stable-snapshot";

/** The snapshot's packages whose pins differ from main's, markers included:
 * publish's stable-behind, and what candidate.ts's catch-up catches up. */
export const hasSnapshot = (t: string) => tryRun("git", ["rev-parse", "-q", "--verify", `${t}:versions/stable`]).status === 0;
export function behind(t: string): string[] {
  // No snapshot at all (a test tree): nothing lags.
  if (!hasSnapshot(t)) return [];
  return SOURCES.filter((s) => {
    // A missing pin is no blob (rev-parse echoes what it was asked).
    const blob = (p: string) => { const r = tryRun("git", ["rev-parse", "-q", "--verify", `${t}:${p}`]); return r.status === 0 ? r.stdout : ""; };
    return blob(`versions/${s.repo}.json`) !== blob(`versions/stable/${s.repo}.json`);
  }).map((s) => s.repo);
}

