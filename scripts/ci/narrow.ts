// Narrowing, as in t3code-nix (narrow.ts): when the candidate fails, test
// main alone and each input alone; the final tree, main plus the inputs that
// passed, gets the full suite again.
//
//   node narrow.ts plan DIR RESULTS [OBS]   failed=true|false, legs=[...]
//   node narrow.ts decide DIR RESULTS        {final, observations}
//   node narrow.ts verdict DIR RESULTS SET NAMES
//                                            {ok, tree, observations}
//
// Results are test.ts's, merged (merge-parts.ts): result-SET-SYSTEM.json.
// Each names the tree it tested, which must be the tree the set stands for.
// Only complete results of the default suite count, on both systems: a
// failure on one system while the other's result is missing proves nothing
// (incomplete), a failure on NixOS stable alone never makes env-broken, and
// a missing result is an update-failed that holds nothing.
//
// An input alone runs the checks test.ts scopes it to and skips the others;
// it inherits main's verdict for each one it skips on that system, so a
// failure main already has is never blamed on a combination later, and a
// missing main result leaves the input's incomplete when it skipped any
// check (only the checks its tree has count: results' `present`).
// `default-build` isn't inherited: its derivation is every input's, and only
// the full suites run it.
//
// The nixpkgs-stable input (the NixOS-stable pin) changes no default check,
// so it is gated on NixOS stable instead, as in t3code-nix: a candidate with
// it narrows unless its stable group (stable-*-stable.json) passed, complete,
// on both systems; main and nixpkgs-stable alone also run the stable group;
// the input passes alone only with no stable failure main doesn't have
// (complete on both systems), and a final with it publishes only on the same
// terms. A stable snapshot marker (`stable-<repo>`) changes no default check
// either: it takes main's default result, and needs no job of its own.
/** Takes main's result, with no narrowing job of its own (KINDS). */
const mainsResult = (i: Input) => !rules(i).ownJob;
/** Gated on NixOS stable too (KINDS: the nixpkgs-stable pin). */
const gated = (i: Input) => rules(i).stableGated;
/** An input in words: its name, and its version when it has one. */
const named = (i: Input) => (i.to ? `${i.name} ${i.to}` : i.name);
//
// - env-broken: only when main fails and every input fails too, so a change
//   that fixes main still gets through (main fails and one input passes:
//   that input publishes).
// - With a single input, its result is the candidate's.
// - An input that fails alone is held (test-failed, keyed by its release's
//   fingerprint); one that passes alone but fails in the final tree is held
//   as combination-failed.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEMS } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";
import { load as loadCandidate, rules, tree, type Input } from "./candidate.ts";
import type { Result } from "./test.ts";
import { TEST_PARTS } from "../lib/parts.ts";

export type Outcome = "pass" | "fail" | "incomplete";
export type Sets = Map<string, Map<string, Result>> & { stable?: Map<string, Map<string, { complete: boolean; failed: string[]; tree?: string }>> };

export function load(dir: string): Sets {
  const sets: Sets = new Map();
  if (!existsSync(dir)) return sets;
  for (const system of SYSTEMS) {
    for (const f of readdirSync(dir)) {
      const m = new RegExp(`^result-(.+)-${system}\\.json$`).exec(f);
      if (!m) continue;
      try {
        const r: Result = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (r.set !== m[1] || r.system !== system || r.part !== null) continue;
        if (!sets.has(m[1])) sets.set(m[1], new Map());
        sets.get(m[1])!.set(system, r);
      } catch { /* a forged or broken file counts as missing */ }
    }
  }
  // NixOS stable's group results (stable.ts), by set and system.
  sets.stable = new Map();
  for (const f of readdirSync(dir)) {
    const m = /^stable-(.+)-(x86_64-linux|aarch64-linux)-stable\.json$/.exec(f);
    if (!m) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      // stable.ts's own shape and identity, not just the file's name.
      if (r?.set !== m[1] || r?.system !== m[2] || r?.group !== "stable" || typeof r?.complete !== "boolean"
        || !Array.isArray(r?.failed) || typeof r?.tree !== "string") continue;
      if (!sets.stable.has(m[1])) sets.stable.set(m[1], new Map());
      sets.stable.get(m[1])!.set(m[2], r);
    } catch { /* missing */ }
  }
  return sets;
}

export const stableFailing = (sets: Sets, set: string) =>
  SYSTEMS.flatMap((s) => (sets.stable?.get(set)?.get(s)?.failed ?? []).map((f) => `${f} (${s})`)).join(", ") || "incomplete";

/** A set's NixOS-stable group outcome: failures only with complete results
 * on both systems, less those `base` (main) has too when given. */
export function stableOutcome(sets: Sets, set: string, base: string | null = null, expected: Map<string, string> | null = null, baseRequired = false): Outcome {
  const of = (x: string) => SYSTEMS.map((s) => {
    const r = sets.stable?.get(x)?.get(s);
    // The exact tree the set stands for, when it's known.
    return r && r.complete && (!expected?.has(x) || r.tree === expected.get(x)) ? r : null;
  });
  const mine = of(set);
  if (mine.some((r) => !r)) return "incomplete";
  let failed = mine.flatMap((r, i) => r!.failed.map((f) => `${SYSTEMS[i]}\0${f}`));
  if (base) {
    const theirs = of(base);
    if (theirs.some((r) => !r)) return failed.length || baseRequired ? "incomplete" : "pass";
    const known = new Set(theirs.flatMap((r, i) => r!.failed.map((f) => `${SYSTEMS[i]}\0${f}`)));
    failed = failed.filter((f) => !known.has(f));
  }
  return failed.length ? "fail" : "pass";
}

/** The result SET counts with on a system: its own, plus, for an input
 * alone, main's verdicts for the checks it skipped (those its tree has, not
 * run because their derivations are main's). Null when missing, incomplete,
 * not of the expected tree, or when main has no verdict on a skipped check.
 * A check the input's tree no longer has (a package marked unavailable) is
 * neither inherited nor needed from main. */
export function effective(sets: Sets, set: string, system: string, expected: Map<string, string> | null = null, inputAlone = false): Result | null {
  const r = sets.get(set)?.get(system);
  if (!r || !r.complete) return null;
  if (expected?.has(set) && r.tree !== expected.get(set)) return null;
  if (!inputAlone) return r;
  const raw = sets.get("main")?.get(system);
  const main = raw && (!expected?.has("main") || raw.tree === expected.get("main")) ? raw : null;
  // Skipped nothing (its tree's every check ran): main's verdicts aren't
  // needed at all, even when main has none.
  if (r.present && !r.present.some((c) => c !== "default-build" && !r.checked.includes(c))) return r;
  if (!main) return null;
  // Without `present` (an older result), as before: every check main ran.
  const skipped = (r.present ?? main.checked).filter((c) => c !== "default-build" && !r.checked.includes(c));
  // Main's verdict on each skipped check: there, and not left incomplete.
  if (!main.complete && (!r.present || skipped.some((c) => main.incomplete.includes(c) || !main.checked.includes(c)))) return null;
  const inherited = main.failed.filter((c) => skipped.includes(c));
  return { ...r, failed: [...new Set([...r.failed, ...inherited])].sort() };
}
/** A set's outcome: a failure only with complete results on both systems. */
export function outcome(sets: Sets, set: string, expected: Map<string, string> | null = null, inputAlone = false): Outcome {
  const rs = SYSTEMS.map((s) => effective(sets, set, s, expected, inputAlone));
  if (rs.some((r) => !r)) return "incomplete";
  return rs.some((r) => r!.failed.length) ? "fail" : "pass";
}
export const failingChecks = (sets: Sets, set: string, inputAlone = false) =>
  SYSTEMS.flatMap((s) => (effective(sets, set, s, null, inputAlone)?.failed ?? sets.get(set)?.get(s)?.failed ?? []).map((c) => `${c} (${s})`)).join(", ");

/** The sets narrowing tests, or null when the candidate passed. */
export function plan(inputs: Input[], sets: Sets, expected: Map<string, string> | null = null): string[] | null {
  const stableGated = inputs.some(gated);
  if (outcome(sets, "candidate", expected) === "pass" && (!stableGated || stableOutcome(sets, "candidate", null, expected) === "pass")) return null;
  // Snapshot markers take main's result: no job of their own.
  const own = inputs.filter((i) => !mainsResult(i));
  return own.length <= 1 && inputs.length === own.length ? ["main"] : ["main", ...own.map((i) => i.name)];
}
/** The narrowing jobs: main alone in the full suite's parts, like the
 * candidate; each input alone whole (it runs only its own checks). Main and
 * a stable-gated input alone also run NixOS stable's group (`stable: true`). */
export const legs = (sets: string[], inputs: Input[] = []) =>
  sets.flatMap((set) => [
    ...(set === "main" ? TEST_PARTS.map((part) => ({ set, part, stable: false })) : [{ set, part: "", stable: false }]),
    ...(set === "main" || inputs.some((i) => i.name === set && gated(i)) ? [{ set, part: "stable", stable: true }] : []),
  ]);

export interface Decision {
  final: string[];
  observations: Observation[];
}
export function decide(inputs: Input[], sets: Sets, expected: Map<string, string> | null = null): Decision {
  const observations: Observation[] = [];
  const single = inputs.length === 1;
  // The default suite's verdict, which alone classifies the environment.
  const defaultOf = (i: Input): Outcome => mainsResult(i) ? outcome(sets, "main", expected)
    : single ? outcome(sets, "candidate", expected) : outcome(sets, i.name, expected, true);
  const stableSet = (i: Input) => (single ? "candidate" : i.name);
  const own = (i: Input): Outcome => {
    const d = defaultOf(i);
    if (!gated(i) || d !== "pass") return d;
    // Stable-gated: its stable group, beside main's (required).
    return stableOutcome(sets, stableSet(i), "main", expected, true);
  };
  const main = outcome(sets, "main", expected);
  const results = inputs.map((i) => ({ i, o: own(i), d: defaultOf(i) }));
  // Main's NixOS-stable evidence, from narrowing's main leg, whatever lands.
  const mainStable = stableOutcome(sets, "main", null, expected);
  // Scoped "main": the issues step lets a landed tree's evidence (publish's)
  // supersede it (issues.ts precedence).
  if (mainStable === "pass") observations.push(obs("stable-ok", null, null, "", { channel: "main" }));
  if (mainStable === "fail") observations.push(obs("stable-broken", null, null, `NixOS stable fails on main: ${stableFailing(sets, "main")}`, { channel: "main" }));
  if (main === "fail" && results.length && results.every((r) => r.d === "fail")) {
    observations.push(obs("env-broken", null, null, `main fails on its own (${failingChecks(sets, "main")}), and so does every input`));
    return { final: [], observations };
  }
  if (main !== "fail" && main !== "incomplete") observations.push(obs("env-ok", null));
  const final: string[] = [];
  for (const { i, o } of results) {
    if (o === "pass") final.push(i.name);
    else if (o === "fail" && main === "incomplete") {
      // Without main's verdict a failure may be the environment's: no hold.
      observations.push(obs("update-failed", null, null, `${named(i)} failed, but main's results are incomplete`));
    } else if (o === "fail" && mainsResult(i)) {
      // Main's own failure (main failed, some input didn't): not this
      // input's; it simply doesn't land.
    } else if (o === "fail" && !rules(i).holdable) {
      // Main's own release with only its marker moved: never a hold on it.
      observations.push(obs("update-failed", null, null, `${named(i)} (only its unavailable marker) failed alone: ${single ? failingChecks(sets, "candidate") : failingChecks(sets, i.name, true)}`));
    } else if (o === "fail") {
      const why = gated(i) && defaultOf(i) === "pass"
        ? `NixOS stable fails with it (beyond main's failures): ${stableFailing(sets, stableSet(i))}`
        : `failed alone: ${single ? failingChecks(sets, "candidate") : failingChecks(sets, i.name, true)}`;
      observations.push(obs("test-failed", i.name, i.to, why, i.fingerprint ? { fingerprint: i.fingerprint } : {}));
    } else {
      // Missing results hold nothing.
      observations.push(obs("update-failed", null, null, `${named(i)}: its results alone are incomplete`));
    }
  }
  return { final, observations };
}

/** Whether SET (candidate or final) may be published: it passed on both
 * systems, on the expected tree. (test-passed comes from publish, once the
 * set has landed.) A failing final holds its inputs as combination-failed. */
export function verdict(inputs: Input[], sets: Sets, set: string, names: string[], expected: Map<string, string> | null = null): { ok: boolean; observations: Observation[] } {
  const o = outcome(sets, set, expected);
  const chosen = inputs.filter((i) => names.includes(i.name));
  const fp = (i: Input) => (i.fingerprint ? { fingerprint: i.fingerprint } : {});
  if (o === "pass" && chosen.some(gated)) {
    // A narrowed final is judged beside main's stable results, which must be
    // there (the publish job downloads narrowing's main legs).
    const so = stableOutcome(sets, set, set === "final" ? "main" : null, expected, set === "final");
    if (so === "pass") return { ok: true, observations: [] };
    return { ok: false, observations: so === "fail"
      ? chosen.filter(gated).map((i) => obs("combination-failed", i.name, i.to, `NixOS stable fails with it in the ${set} set: ${stableFailing(sets, set)}`, fp(i)))
      : [obs("update-failed", null, null, `the ${set} set's NixOS stable results are incomplete`)] };
  }
  if (o === "pass") return { ok: true, observations: [] };
  // Only holdable kinds (KINDS) are held: a marker, a snapshot marker or the
  // catch-up tests no release of its own.
  const blamed = chosen.filter((i) => rules(i).holdable);
  if (o === "fail" && set === "final" && !blamed.length) {
    // Only stable markers and the catch-up, neither ever held: main's tree
    // (and the snapshot's markers) failing again is no release's, but not
    // silent.
    return { ok: false, observations: [obs("update-failed", null, null, `the final set (${names.join(", ")}) failed: ${failingChecks(sets, set)}`)] };
  }
  if (o === "fail" && set === "final") {
    return { ok: false, observations: blamed.map((i) => obs("combination-failed", i.name, i.to, `passed alone, failed with ${names.filter((n) => n !== i.name).join(", ") || "main"}: ${failingChecks(sets, set)}`, fp(i))) };
  }
  if (o === "fail" && set === "candidate" && chosen.length === 1 && blamed.length === 1) {
    return { ok: false, observations: [obs("test-failed", blamed[0].name, blamed[0].to, failingChecks(sets, set), fp(blamed[0]))] };
  }
  return { ok: false, observations: o === "incomplete" ? [obs("update-failed", null, null, `the ${set} results are incomplete`)] : [] };
}

/** The tree each set stands for: candidate (every input), main (the base),
 * each input alone, and final (the given names). */
export function expectedTrees(dir: string, final: string[] | null = null): Map<string, string> {
  const c = loadCandidate(dir);
  const m = new Map<string, string>([["candidate", tree(dir)], ["main", tree(dir, "")]]);
  for (const i of c.inputs) if (!mainsResult(i)) m.set(i.name, tree(dir, i.name));
  if (final) m.set("final", tree(dir, final.join(",")));
  return m;
}

if (import.meta.main) {
  const [cmd, dir, results, a, b] = process.argv.slice(2);
  const c = loadCandidate(dir);
  const sets = load(results);
  if (cmd === "plan") {
    const p = plan(c.inputs, sets, expectedTrees(dir));
    if (a) writeFileSync(a, JSON.stringify({ observations: [] }) + "\n");
    console.log(`failed=${p ? "true" : "false"}`);
    console.log(`legs=${JSON.stringify(legs(p ?? [], c.inputs))}`);
  } else if (cmd === "decide") {
    console.log(JSON.stringify(decide(c.inputs, sets, expectedTrees(dir)), null, 2));
  } else if (cmd === "verdict" && a) {
    const names = (b ?? "").split(",").filter(Boolean);
    const v = verdict(c.inputs, sets, a, names, expectedTrees(dir, a === "final" ? names : null));
    console.log(JSON.stringify({ ...v, tree: v.ok ? tree(dir, names.join(",")) : null }, null, 2));
  } else {
    console.error("usage: narrow.ts plan|decide|verdict DIR RESULTS [...]");
    process.exit(2);
  }
}
