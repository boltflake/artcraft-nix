// Reconcile this repo's tags and GitHub Releases with main's history, as in
// t3code-nix's reconcile.ts, for this repo's release names.
//
//   node reconcile.ts [REF]        (default origin/main)
//
// Idempotent. Walks REF's first-parent history, oldest first; every commit
// with a release trailer (lib/releases.ts) should have the tag of that name
// on it and a GitHub Release for it:
// - a missing tag is created on that commit; a tag of that name on another
//   commit is reported (tag-mismatch) and never moved; so is a release-name
//   tag that no commit on main names (made by hand);
// - a missing Release is created, in history order, with the packages at
//   that commit and every version change since the previous trailer commit;
// - the Latest marker goes on the newest commit with a trailer, including
//   after a downgrade; latest-mismatch if it can't be put there (its tag
//   conflicts, or marking it didn't take).
// As in t3code-nix, it also deletes candidate refs (bot/candidate/<run>) left
// by runs that have finished, and re-enables the scheduled workflows GitHub
// disables after 60 days without activity.
// Prints {observations, dryRun}.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { changesBetween, firstParent, pinsAt, releaseBody, type Commit } from "../lib/releases.ts";
import { obs, type Observation } from "../update.ts";
import { client, REPO, type Client } from "./gh.ts";

export interface Planned { name: string; sha: string; previous: string | null; first: boolean }

/** The trailer commits, oldest first, each with the previous one. */
export function planned(commits: Commit[]): Planned[] {
  const out: Planned[] = [];
  let previous: string | null = null;
  for (const c of [...commits].reverse()) {
    if (!c.trailer) continue;
    out.push({ name: c.trailer, sha: c.sha, previous, first: previous === null });
    previous = c.sha;
  }
  return out;
}

export const SCHEDULED: [string, string][] = [
  ["health.yml", "backstop-enabled"],
  ["pages.yml", "pages-enabled"],
  ["tooling.yml", "tooling-enabled"],
];

export async function reconcile(gh: Client, ref = "origin/main", commits: Commit[] = firstParent(ref),
  body = (p: Planned) => releaseBody(p.name, p.sha, pinsAt(p.sha), changesBetween(commits, p.previous, p.sha), p.first, REPO),
  workflowsDir = ".github/workflows"): Promise<Observation[]> {
  const observations: Observation[] = [];
  // Housekeeping first, but never at the cost of the tags and releases.
  try {
    for (const [r] of Object.entries(await gh.refs("heads/bot/candidate/"))) {
      const run = r.slice("refs/heads/bot/candidate/".length);
      if (/^\d+$/.test(run) && (await gh.runCompleted(run))) await gh.deleteRef(r);
    }
  } catch (e: any) {
    console.error(`reconcile: couldn't clean up candidate refs: ${e?.message ?? e}`);
  }
  for (const [w, kind] of SCHEDULED.filter(([w]) => existsSync(join(workflowsDir, w)))) {
    try {
      if ((await gh.workflowState(w)) !== "disabled_inactivity") continue;
      await gh.enableWorkflow(w);
      observations.push(obs(kind, null, null, `GitHub had disabled ${w} after 60 days without activity`));
    } catch (e: any) {
      console.error(`reconcile: couldn't check or re-enable ${w}: ${e?.message ?? e}`);
    }
  }
  const want = planned(commits);
  const tags = await gh.refs("tags/20");
  const releases = new Map((await gh.releases()).map((r) => [r.tag, r]));
  let conflicts = 0;
  for (const p of want) {
    const ref = `refs/tags/${p.name}`;
    const at = tags[ref];
    if (at && at !== p.sha) {
      conflicts++;
      observations.push(obs("tag-mismatch", null, p.name, `tag ${p.name} is on ${at}, but main's trailer names ${p.sha}; it's never moved, so look into it by hand`));
      continue;
    }
    if (!at) await gh.createRef(ref, p.sha);
    if (!releases.has(p.name)) {
      const r = await gh.createRelease({ tag: p.name, target: p.sha, name: p.name, body: body(p) });
      releases.set(p.name, r);
    }
  }
  // A release-name tag no trailer names (made by hand: publish pushes main
  // and its tag atomically): never moved or deleted here, but reported.
  const named = new Set(want.map((p) => p.name));
  for (const ref of Object.keys(tags)) {
    const name = ref.slice("refs/tags/".length);
    if (/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(name) && !named.has(name)) {
      conflicts++;
      observations.push(obs("tag-mismatch", null, name, `tag ${name} is on ${tags[ref]}, but no commit on main names it; it's never moved, so look into it by hand`));
    }
  }
  if (!conflicts) observations.push(obs("tag-ok", null));
  // The required Latest: the newest trailer commit's release, never an older
  // one standing in for it.
  const newest = want.at(-1);
  if (newest) {
    const at = tags[`refs/tags/${newest.name}`];
    if ((at && at !== newest.sha) || !releases.has(newest.name)) {
      observations.push(obs("latest-mismatch", null, newest.name, `the newest release, ${newest.name}, can't be marked Latest: its tag is on another commit`));
    } else if ((await gh.latestRelease())?.tag === newest.name) {
      observations.push(obs("latest-match", null, newest.name));
    } else {
      try {
        await gh.markLatest(releases.get(newest.name)!);
        const now = (await gh.latestRelease())?.tag;
        observations.push(now === newest.name
          ? obs("latest-match", null, newest.name)
          : obs("latest-mismatch", null, newest.name, `marked ${newest.name} Latest, but GitHub's Latest is ${now ?? "none"}`));
      } catch (e: any) {
        observations.push(obs("latest-mismatch", null, newest.name, `couldn't mark ${newest.name} Latest: ${e?.message ?? e}`));
      }
    }
  }
  return observations;
}

if (import.meta.main) {
  const [ref] = process.argv.slice(2);
  const gh = client();
  const observations = await reconcile(gh, ref ?? "origin/main");
  console.log(JSON.stringify({ observations, dryRun: gh.actions ?? null }, null, 2));
}
