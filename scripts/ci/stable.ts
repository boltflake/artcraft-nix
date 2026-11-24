// NixOS stable's legs, as in t3code-nix's stable.ts: the stable group (the
// snapshot's pins on nixpkgs-stable, legacyPackages.<system>.ci.stableChecks)
// and the stable-next group (the tree's pins on nixpkgs-stable,
// stableNextChecks), built apart from the default checks so nothing about
// NixOS stable can fail or delay them.
//
//   node stable.ts SET SYSTEM OUT_DIR --tree=TREE [--group=stable|next] [--parent=TREE]
//   node stable.ts SET OUT_DIR --move-json
//
// Unpacks TREE (a tree in this repository's objects) and builds the group's
// checks. Writes OUT_DIR/stable-SET-SYSTEM-GROUP.json: {set, system, group,
// tree, complete, failed, equivalent, branch}, and the smokes' logs under
// OUT_DIR/smokes/stable-SET-SYSTEM-GROUP/.
//
// The stable-next group also runs the equivalence step: with the snapshot
// moved to TREE's pins, every default check's derivation is unchanged, and
// the moved tree's stable checks are exactly the stable-next checks just
// built (same names, same derivations). Only then may publish move the
// snapshot (--move-json: stable-next passed, complete and equivalent, on both
// systems).
//
// With --parent (branch CI), `branch` lists the failures this commit
// introduces: those the parent's tree passes (or, when the parent's result is
// incomplete, every failure); branch CI fails on any.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { movedTree } from "../lib/snapshot.ts";
import { SYSTEMS, tryRun, writeJson } from "../lib/util.ts";
import { CHECKS_APPLY, type Check } from "./test.ts";

export type Group = "stable" | "next";
export interface StableResult {
  set: string; system: string; group: Group; tree?: string; complete: boolean; failed: string[];
  /** stable-next only: the equivalence step passed. */
  equivalent?: boolean; equivalence?: string; branch?: string[];
  /** The equivalence step couldn't be judged (an evaluation error): no
   * verdict on the move, retried. */
  equivalenceUnknown?: boolean;
}

export function unpack(tree: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stable-"));
  const r = tryRun("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", tree, dir]);
  if (r.status !== 0) throw new Error(`couldn't unpack ${tree}: ${r.stderr}`);
  return dir;
}

const attrOf = (group: Group) => (group === "stable" ? "stableChecks" : "stableNextChecks");
export function evaluate(src: string, _system: string, attr: string): Record<string, Check> | null {
  const e = tryRun("nix", ["eval", "--json", `path:${src}#${attr}`, "--apply", CHECKS_APPLY], { timeout: 20 * 60_000 });
  if (e.status !== 0) {
    console.error(e.stderr);
    return null;
  }
  return JSON.parse(e.stdout);
}

export function runGroup(src: string, set: string, system: string, group: Group, out: string | null = null): StableResult {
  const attr = `legacyPackages.${system}.ci.${attrOf(group)}`;
  const checks = evaluate(src, system, attr);
  if (!checks) return { set, system, group, complete: false, failed: [] };
  const names = Object.keys(checks).filter((n) => !n.endsWith("-run")).sort();
  const build = (ns: string[]) => !!ns.length && !!tryRun("nix", ["build", "--keep-going", "--no-link", "-L", ...ns.map((n) => `path:${src}#${attr}.${n}`)],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 40 * 60_000 }).cut;
  const valid = (p: string) => tryRun("nix-store", ["--check-validity", p]).status === 0;
  build(names);
  // Once more, rerunning a failed smoke itself (see test.ts).
  const missing = names.filter((n) => !valid(checks[n].out));
  for (const n of missing) if (checks[`${n}-run`] && valid(checks[`${n}-run`].out)) tryRun("nix-store", ["--delete", checks[`${n}-run`].out]);
  // A build cut short (a timeout, a signal) leaves no verdict on what it
  // didn't build: incomplete, never failed.
  const cut = build(missing);
  const failedNow = names.filter((n) => !valid(checks[n].out));
  const incomplete = failedNow.filter((n) => cut || (checks[`${n}-run`] && !valid(checks[`${n}-run`].out)));
  if (out) {
    for (const n of names) {
      const run = checks[`${n}-run`];
      if (!run || !valid(run.out)) continue;
      const dest = join(out, "smokes", `stable-${set}-${system}-${group}`, n);
      mkdirSync(dest, { recursive: true });
      cpSync(run.out, dest, { recursive: true, dereference: true });
    }
  }
  return { set, system, group, complete: incomplete.length === 0, failed: failedNow.filter((n) => !incomplete.includes(n)) };
}

/** The equivalence step (see the top). */
export function equivalence(tree: string, testedSrc: string, system: string): { equivalent: boolean; why: string; unknown?: boolean } {
  let moved: string;
  try {
    moved = movedTree(tree);
  } catch (e: any) {
    return { equivalent: false, why: e.message, unknown: true };
  }
  if (moved === tree) return { equivalent: true, why: "the snapshot already equals the tree's pins" };
  const movedSrc = unpack(moved);
  try {
    const before = evaluate(testedSrc, system, `checks.${system}`);
    const after = evaluate(movedSrc, system, `checks.${system}`);
    if (!before || !after) return { equivalent: false, why: "the default checks didn't evaluate", unknown: true };
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((n) => before[n]?.drv !== after[n]?.drv);
    if (changed.length) return { equivalent: false, why: `moving the snapshot changes default checks: ${changed.join(", ")}` };
    const next = evaluate(testedSrc, system, `legacyPackages.${system}.ci.stableNextChecks`);
    const stable = evaluate(movedSrc, system, `legacyPackages.${system}.ci.stableChecks`);
    if (!next || !stable) return { equivalent: false, why: "the stable checks didn't evaluate", unknown: true };
    const bare = (o: Record<string, Check>, prefix: string) => new Map(Object.entries(o).map(([n, c]) => [n.slice(prefix.length), c.drv]));
    const a = bare(next, "stable-next-"), b = bare(stable, "stable-");
    const differ = [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n));
    return differ.length
      ? { equivalent: false, why: `the moved snapshot's stable checks aren't the tested stable-next ones: ${differ.join(", ")}` }
      : { equivalent: true, why: "moving the snapshot changes no default check, and gives exactly the tested stable-next checks" };
  } finally {
    rmSync(movedSrc, { recursive: true, force: true });
  }
}

/** The failures a branch introduces: an incomplete result is one in
 * itself; a failure the parent shares (complete) isn't the branch's. */
export function regressions(ours: StableResult, parent: StableResult | null): string[] {
  if (!ours.complete) return ["(incomplete)"];
  if (!parent || !parent.complete) return ours.failed;
  return ours.failed.filter((f) => !parent.failed.includes(f));
}

/** publish's MOVE_JSON from the stable results of the set it publishes, all
 * of the given tree: whether the snapshot moves, and the stable group's own
 * outcome. */
export function moveOf(dir: string, set: string, tree: string | null = null): { move: boolean; reason: string; stable: "pass" | "fail" | "incomplete"; stableFailed: string[]; decided: boolean } {
  const results: StableResult[] = readdirSync(dir).filter((f) => f.startsWith(`stable-${set}-`) && f.endsWith(".json")).map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
  }).filter((r) => r && (!tree || r.tree === tree));
  const of = (group: Group) => SYSTEMS.map((s) => results.find((r) => r.system === s && r.group === group));
  const snap = of("stable");
  const stableFailed = snap.flatMap((r) => (r?.complete ? r.failed.map((f) => `${f} (${r.system})`) : []));
  const stable = snap.some((r) => !r || !r.complete) ? "incomplete" : stableFailed.length ? "fail" : "pass";
  const next = of("next");
  // `decided`: stable-next's results were complete, so a move that didn't
  // happen won't happen for this tree on a retry either.
  const base = { stable, stableFailed, decided: true } as const;
  if (next.some((r) => !r || !r.complete)) return { move: false, reason: "stable-next's results are incomplete", ...base, decided: false };
  const failed = next.flatMap((r) => r!.failed.map((f) => `${f} (${r!.system})`));
  if (failed.length) return { move: false, reason: `stable-next failed: ${failed.join(", ")}`, ...base };
  const notEq = next.filter((r) => !r!.equivalent);
  if (notEq.length) return { move: false, reason: `the equivalence step didn't pass: ${notEq.map((r) => `${r!.system}: ${r!.equivalence ?? "not run"}`).join("; ")}`, ...base,
    decided: notEq.every((r) => r!.equivalence !== undefined && !r!.equivalenceUnknown) };
  // The snapshot moves to exactly what stable-next tested: that's its state.
  return { move: true, reason: "stable-next passed, and the move is equivalent, on both systems", stable: "pass", stableFailed: [], decided: true };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pos = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--move-json")) {
    const [set, out] = pos;
    console.log(JSON.stringify(moveOf(out, set, argv.find((a) => a.startsWith("--tree="))?.slice(7) ?? null)));
    process.exit(0);
  }
  const [set, system, out] = pos;
  const tree = argv.find((a) => a.startsWith("--tree="))?.slice(7);
  const group = (argv.find((a) => a.startsWith("--group="))?.slice(8) ?? "stable") as Group;
  if (!set || !system || !out || !tree || !["stable", "next"].includes(group)) {
    console.error("usage: stable.ts SET SYSTEM OUT_DIR --tree=TREE [--group=stable|next] [--parent=TREE]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const parent = argv.find((a) => a.startsWith("--parent="))?.slice(9);
  const src = unpack(tree);
  let code = 1;
  try {
    const r: StableResult = { ...runGroup(src, set, system, group, out), tree };
    if (group === "next" && set !== "branch") {
      const eq = equivalence(tree, src, system);
      r.equivalent = eq.equivalent;
      r.equivalence = eq.why;
      if (eq.unknown) r.equivalenceUnknown = true;
    }
    if (parent) {
      let theirs: StableResult | null = null;
      if (r.failed.length || !r.complete) {
        const psrc = unpack(parent);
        try { theirs = runGroup(psrc, "parent", system, group); } finally { rmSync(psrc, { recursive: true, force: true }); }
      }
      r.branch = regressions(r, theirs);
    }
    writeJson(join(out, `stable-${set}-${system}-${group}.json`), r);
    console.log(`NixOS ${group === "stable" ? "stable" : "stable-next"} ${system}: ${r.complete ? `${r.failed.length} failed` : "incomplete"}${r.equivalence ? `; ${r.equivalence}` : ""}`);
    code = r.complete ? 0 : 1;
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  process.exit(code);
}
