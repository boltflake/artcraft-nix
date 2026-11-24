// Publish a tested candidate to main (the publish job), as in t3code-nix's
// publish.ts, with this repo's release names.
//
//   node publish.ts CANDIDATE_DIR FINAL_NAMES EXPECTED_TREE [MOVE_JSON]
//
// Runs in a checkout of the candidate's base, with push credentials.
// Environment: RUN_ID, RUN_URL, ATTEMPT, DRY_RUN, GITHUB_REF.
//
// 1. The tree of the base plus exactly the final inputs must be the tree the
//    tests ran on. With MOVE_JSON ({move: true} when stable-next passed on
//    both systems), the NixOS-stable snapshot moves: versions/stable/ takes
//    the tree's pins, and the published tree is checked to differ from the
//    tested one only there (no default check reads the snapshot, so the
//    default results stand for it).
// 2. When the publish changes an app's version, it allocates a release name,
//    YYYY.MM.DD.N (lib/releases.ts), on the base's first-parent history, and
//    writes it as the commit's trailer.
// 3. It first checks main hasn't moved (else it re-dispatches the workflow,
//    attempt + 1, at most 3 runs in a row; the new run allocates again on its
//    new base). Then it pushes the commit to refs/heads/bot/candidate/<run>
//    (GitHub must have it before a status can go on it), posts `tested`, and
//    pushes it to main with the tag in one atomic push, without force; the
//    candidate ref is deleted whatever happens (reconcile removes leftovers).
// 4. A rejected push: this run's own commit already on main (its
//    Artcraft-Run trailer, this tree on this base; an earlier try landed
//    before a timeout) counts as done; main moved: re-dispatch; otherwise a
//    real failure.
// 5. Only what landed is evidence: test-passed for each input, and a
//    downgrade for an input that moved back.
// 6. The snapshot catch-up (candidate.ts's file-less stable-snapshot input):
//    lands only when the snapshot moves, with no release name and no
//    test-passed; otherwise nothing lands, and only the stable evidence is
//    returned. A stable-behind whose stable-next was complete carries the
//    tree (fingerprint `tree:<tree>`), so idle runs don't retry it.
//
// Prints {observations, release, dryRun}.
import { Failed, git, timing, tryRun } from "../lib/util.ts";
import { allocate, firstParent, needsRelease, trailerOf, TRAILER } from "../lib/releases.ts";
import { compareVersions } from "../../shared/sources.ts";
import { obs, type Observation } from "../update.ts";
import { kindOf, load, rules, tree, type Input } from "./candidate.ts";
import { behind, movedTree } from "../lib/snapshot.ts";
import { client, type Client } from "./gh.ts";

/** At most this many runs in a row (the first and two re-dispatches). */
export const MAX_ATTEMPTS = 3;
/** publish's MOVE_JSON (stable.ts --move-json): whether the snapshot moves,
 * and the stable group's own outcome on the published set. */
export interface Move { move: boolean; reason?: string; stable?: "pass" | "fail" | "incomplete"; stableFailed?: string[]; decided?: boolean }
export const PUSH_TRIES = 4;
export const PUSH_WAIT_MS = 5000;
const STATUS_LAG = 'Required status check "tested" is expected';
const BOT = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];

/** The run's timing, for the status page's speed figures (the critical path
 * is computed from the job graph with each job's queue time taken out, not by
 * subtracting queue time from the measured path).
 * - The queue-free path: the stages run one after another (resolve, test,
 *   narrow-plan, narrow, decide, final, publish), each as long as its
 *   longest job (started to completed; publish: to now).
 * - `queue` is the run's elapsed time to now (from its start) less that
 *   path, so the page's (main moved − publishedAt − queue) is the watcher's
 *   delay plus the queue-free path.
 * - `waited`: how long the run waited behind another update run (from its
 *   creation to its start), counted only if a real run was in progress when
 *   it was created; 0 otherwise.
 * Null when any timing field is missing: that release is left out of the
 * target figure. */
export interface Timing { queue: number; waited: number }
export const STAGES = ["resolve", "test", "narrow-plan", "narrow", "decide", "final", "publish"];
export function timingOf(run: any, jobs: any[], others: any[], now: number): Timing | null {
  const created = Date.parse(run?.created_at ?? ""), started = Date.parse(run?.run_started_at ?? "");
  if (!Number.isFinite(created) || !Number.isFinite(started)) return null;
  let path = 0;
  for (const stage of STAGES) {
    const mine = jobs.filter((j) => j?.name === stage || String(j?.name ?? "").startsWith(`${stage} (`));
    if (!mine.length) continue;
    let longest = 0;
    for (const j of mine) {
      const st = Date.parse(j.started_at ?? "");
      const end = stage === "publish" && !j.completed_at ? now : Date.parse(j.completed_at ?? "");
      if (!Number.isFinite(st) || !Number.isFinite(end) || end < st) return null;
      longest = Math.max(longest, end - st);
    }
    path += longest;
  }
  const elapsed = now - started;
  const ahead = others.some((r) => r?.id !== run.id && /^update( \(retry \d+\))?$/.test(r?.display_title ?? r?.name ?? "")
    && Date.parse(r?.run_started_at ?? "") < created && (r?.status !== "completed" || Date.parse(r?.updated_at ?? "") > created));
  return { queue: Math.max(0, Math.round((elapsed - path) / 1000)), waited: ahead ? Math.max(0, Math.round((started - created) / 1000)) : 0 };
}
async function runTiming(env: NodeJS.ProcessEnv): Promise<Timing | null> {
  const repo = env.GITHUB_REPOSITORY, id = env.RUN_ID, token = env.GH_TOKEN;
  if (!repo || !id || !token) return null;
  try {
    const get = async (path: string) => {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const [run, jobs, runs] = await Promise.all([get(`runs/${id}`), get(`runs/${id}/jobs?filter=latest&per_page=100`),
      get("workflows/update.yml/runs?branch=main&per_page=20")]);
    return timingOf(run, jobs?.jobs ?? [], runs?.workflow_runs ?? [], Date.now());
  } catch (e: any) {
    console.warn(`publish: no run timing: ${e?.message ?? e}`);
    return null;
  }
}

export const commitMessage = (inputs: Input[], final: string[], release: string | null, moved: boolean, timing: Timing | null = null, runId: string | null = null) => {
  const chosen = inputs.filter((i) => final.includes(i.name) && kindOf(i) !== "catch-up");
  const subject = !chosen.length ? "NixOS stable: catch the snapshot up with main"
    : chosen.length === 1
    ? `Update ${chosen[0].name} ${chosen[0].from ?? "(new)"} -> ${chosen[0].to}`
    : `Update ${chosen.map((i) => i.name).join(", ")}`;
  const body = chosen.length > 1 ? chosen.map((i) => `- ${i.name} ${i.from ?? "(new)"} -> ${i.to}`).join("\n") : "";
  const trailers = [
    release ? `${TRAILER}: ${release}` : "",
    // Which update run published it: a re-run of that run recognises its
    // own commit.
    runId ? `Artcraft-Run: ${runId}` : "",
    release && timing ? `Artcraft-Queue: ${timing.queue}\nArtcraft-Waited: ${timing.waited}` : "",
  ].filter(Boolean).join("\n");
  return [subject, body, moved ? "NixOS stable: the snapshot moves to these pins." : "", trailers].filter(Boolean).join("\n\n");
};

export async function publish(dir: string, final: string[], expectedTree: string, gh: Client, env: NodeJS.ProcessEnv,
  remote = "origin", move: Move | null = null, now = new Date()): Promise<{ observations: Observation[]; release: string | null }> {
  const c = load(dir);
  const dry = env.DRY_RUN === "true";
  const attempt = Number(env.ATTEMPT || 0);
  if (!dry && env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") throw new Failed(`a real run publishes only from main, not ${env.GITHUB_REF}`);
  if (git("rev-parse", "HEAD") !== c.base) throw new Failed(`checkout is not the candidate's base ${c.base}`);
  const tested = tree(dir, final.join(","));
  if (tested !== expectedTree) throw new Failed(`tree ${tested} is not the tested tree ${expectedTree}`);
  const published = move?.move ? movedTree(tested) : tested;
  const moved = published !== tested;
  const chosen = c.inputs.filter((i) => final.includes(i.name));
  const observations: Observation[] = [];
  // A catch-up alone whose move didn't pass: nothing to land, only the
  // stable evidence (main's tree is what was tested).
  const catchUpOnly = chosen.length > 0 && chosen.every((i) => kindOf(i) === "catch-up");
  const lagging = behind(published);
  observations.push(lagging.length
    ? obs("stable-behind", null, null, `the NixOS-stable snapshot lags for ${lagging.join(", ")}: ${move?.reason ?? "stable-next didn't pass on both systems"}`,
      // The tree whose move stable-next turned down outright: an idle run
      // doesn't retry its catch-up (held.ts's snapshotStuck).
      move?.decided ? { fingerprint: `tree:${published}` } : {})
    : obs("stable-current", null));
  // The snapshot's own builds (the stable group), independent of lag.
  if (move?.stable === "fail") observations.push(obs("stable-broken", null, null, `NixOS stable fails: ${(move.stableFailed ?? []).join(", ")}`));
  if (move?.stable === "pass") observations.push(obs("stable-ok", null));

  // What reached main: evidence for the issues, only once it has.
  const evidence = (at: string, msg: string, name: string | null): Observation[] => [
    ...observations,
    obs("published", null, name ?? at, msg, { stableChanged: moved || chosen.some((i) => rules(i).changesStable), ...(moved ? { snapshotMoved: true } : {}) }),
    // A set landed after passing the full suite: the build environment works.
    obs("env-ok", null),
    // A marker-only input tested no release: it passes none (a hold on
    // another release of the repository stays).
    ...chosen.filter((i) => rules(i).passes).map((i) => obs("test-passed", i.name, i.to, "", i.fingerprint ? { fingerprint: i.fingerprint } : {})),
    // A move back to an earlier release (upstream pulled the pin) is
    // recorded once it has landed.
    ...chosen.filter((i) => kindOf(i) === "release" && i.from && i.to && compareVersions(i.to, i.from) < 0)
      .map((i) => obs("downgrade", i.name, i.to, `upstream pulled ${i.from}; main moved back to ${i.to}`, { from: i.from!, to: i.to! })),
  ];
  if (catchUpOnly && !moved) {
    // About main's tree as it was: stale if main has moved since (a hand
    // repair, say), and the next run judges the new one.
    if (!dry) {
      git("fetch", "-q", remote, "main");
      if (git("rev-parse", "FETCH_HEAD") !== c.base) return { observations: [obs("main-moved", null, null, "main moved during the catch-up")], release: null };
    }
    return { observations, release: null };
  }
  // Main moved meanwhile: the new run tests against the new main (a tested
  // candidate is never rebased). Checked first, so a release name another
  // publish took meanwhile isn't mistaken for a conflict.
  const redispatch = async (why: string) => {
    // main-moved: this run's evidence about main's tree is stale
    // (issues.ts precedence).
    const mainMoved = obs("main-moved", null, null, why);
    if (attempt + 1 >= MAX_ATTEMPTS) {
      return { observations: [mainMoved, obs("update-failed", null, null, `main kept moving during ${MAX_ATTEMPTS} runs in a row; giving up until the next trigger`)], release: null };
    }
    try {
      await gh.dispatch("update.yml", "main", { attempt: String(attempt + 1) });
    } catch (e: any) {
      // Main-moved still reaches the issues job; the hourly backstop runs
      // the update again.
      return { observations: [mainMoved, obs("update-failed", null, null, `${why}, and re-dispatching failed: ${e?.message ?? e}`)], release: null };
    }
    return { observations: [mainMoved, obs("redispatched", null, null, `${why}; attempt ${attempt + 1}`)], release: null };
  };
  // An earlier try of this very publish that landed (the bot's commit of
  // this tree on this base): done, whatever its release name.
  const landedAt = (head: string) => {
    const msg = git("log", "-1", "--format=%B", head);
    return evidence(head, msg, trailerOf(msg));
  };
  // This very run's commit (its Artcraft-Run trailer), of this tree on this
  // base, with a release trailer exactly when the change needs one.
  // The changes that count for a release name (KINDS `releases`), for both
  // the already-landed check and the allocation.
  const changes = chosen.filter((i) => rules(i).releases).map((i) => ({ repo: i.name, from: i.from, to: i.to ?? "" }));
  const needs = needsRelease(changes);
  const alreadyLanded = (head: string) => {
    const msg = git("log", "-1", "--format=%B", head);
    return git("rev-parse", `${head}^{tree}`) === published
      && tryRun("git", ["rev-parse", `${head}^`]).stdout === c.base
      && git("log", "-1", "--format=%ae", head) === BOT[3].split("=")[1]
      && !!env.RUN_ID && new RegExp(`^Artcraft-Run: ${env.RUN_ID}$`, "m").test(msg)
      && (trailerOf(msg) !== null) === needs;
  };
  if (!dry) {
    git("fetch", "-q", remote, "main");
    const head = git("rev-parse", "FETCH_HEAD");
    if (head !== c.base) {
      if (alreadyLanded(head)) return { observations: landedAt(head), release: trailerOf(git("log", "-1", "--format=%B", head)) };
      return redispatch("main moved during the run");
    }
  }

  // A name a stray tag already holds (one no trailer names: reconcile
  // reports it) is taken too: publish never blocks on it, nor moves it.
  const tagged = dry ? [] : git("ls-remote", "--tags", remote, "refs/tags/20*").split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t);
  const release = needs ? allocate([...firstParent(c.base).map((x) => x.trailer).filter((t): t is string => !!t), ...tagged], now) : null;
  const message = commitMessage(c.inputs, final, release, moved, release ? await runTiming(env) : null, env.RUN_ID ?? null);
  const sha = git(...BOT, "commit-tree", published, "-p", c.base, "-m", message);
  const landed = (at: string) => evidence(at, message, release);

  const candidateRef = `refs/heads/bot/candidate/${env.RUN_ID ?? "local"}`;
  if (dry) {
    await gh.createRef(candidateRef, sha);
    await gh.createStatus(sha, "success", "full suite passed on every system", env.RUN_URL ?? "", "tested");
    await gh.createRef("refs/heads/main", sha);
    if (release) await gh.createRef(`refs/tags/${release}`, sha);
    await gh.deleteRef(candidateRef);
    await gh.dispatch("pages.yml", "main", {});
    return { observations: landed(sha), release };
  }
  if (release && git("ls-remote", "--tags", remote, `refs/tags/${release}`)) {
    // Main may have moved since the first look, taking that name with it.
    git("fetch", "-q", remote, "main");
    const head = git("rev-parse", "FETCH_HEAD");
    if (head !== c.base) {
      if (alreadyLanded(head)) return { observations: landedAt(head), release: trailerOf(git("log", "-1", "--format=%B", head)) };
      return redispatch("main moved during the run");
    }
    throw new Failed(`tag ${release} exists already although main hasn't moved; reconcile reports it`);
  }
  // GitHub must have the commit before a status can go on it: this run's
  // own ref first (forced, so a re-run of a killed publish replaces it).
  git("push", "-q", remote, `+${sha}:${candidateRef}`);
  let result;
  try {
    await gh.createStatus(sha, "success", "full suite passed on every system", env.RUN_URL ?? "", "tested");
    const push = ["push", "--atomic", remote, `${sha}:refs/heads/main`, ...(release ? [`${sha}:refs/tags/${release}`] : [])];
    for (let i = 1; ; i++) {
      result = tryRun("git", push);
      if (result.status === 0 || i >= PUSH_TRIES || !result.stderr.includes(STATUS_LAG)) break;
      console.warn(`publish: push ${i} turned down before GitHub saw \`tested\`; pushing again in ${PUSH_WAIT_MS * i / 1000} s`);
      await timing.sleep(PUSH_WAIT_MS * i);
    }
  } finally {
    // Ours to remove, whatever happened; reconcile removes it otherwise.
    const del = tryRun("git", ["push", "-q", remote, "--delete", candidateRef]);
    if (del.status !== 0) console.warn(`publish: couldn't delete ${candidateRef}: ${del.stderr}`);
  }
  if (result.status === 0) {
    try { await gh.dispatch("pages.yml", "main", {}); } catch (e: any) { console.warn(`publish: couldn't start pages.yml: ${e?.message ?? e}`); }
    return { observations: landed(sha), release };
  }
  git("fetch", "-q", remote, "main");
  const head = git("rev-parse", "FETCH_HEAD");
  if (alreadyLanded(head)) return { observations: landedAt(head), release: trailerOf(git("log", "-1", "--format=%B", head)) };
  if (head === c.base) throw new Failed(`push rejected although main didn't move:\n${result.stderr}`);
  return redispatch("main moved during the publish");
}

if (import.meta.main) {
  const [dir, names, expected, moveJson] = process.argv.slice(2);
  if (!dir || names === undefined || !expected) {
    console.error("usage: publish.ts CANDIDATE_DIR FINAL_NAMES EXPECTED_TREE [MOVE_JSON]");
    process.exit(2);
  }
  const gh = client();
  const r = await publish(dir, names.split(",").filter(Boolean), expected, gh, process.env, "origin", moveJson ? JSON.parse(moveJson) : null);
  console.log(JSON.stringify({ ...r, dryRun: gh.actions ?? null }, null, 2));
}
