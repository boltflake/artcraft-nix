// Run the default suite (or one part of it) on the working tree, as in
// t3code-nix's test.ts: every check is a derivation built in the Nix sandbox.
//
//   node test.ts SET SYSTEM OUT_DIR [--part=PART]
//
// SET names what's tested: candidate, final, main, branch, or one input (a
// repository, nixpkgs or nixpkgs-stable) for narrowing's "an input alone",
// which runs only that repository's checks and the flake-wide ones (every
// check for nixpkgs; for nixpkgs-stable only the flake-wide ones, its
// verdict coming from NixOS stable's group, run in a leg of its own). Within one run every other check's derivation should be the same
// as in "main alone"; to be sure, the base commit's checks are evaluated too,
// and any check whose derivation differs from main's is run as well.
// nix-format runs in branch CI only.
//
// Writes OUT_DIR/result-SET-SYSTEM[-PART].json: {set, system, part, tree,
// complete, checked, failed, incomplete, drvs, present}, and
// OUT_DIR/smokes/SET-SYSTEM[-PART]/<check>/ with each smoke's
// status, log and screenshot (the smoke derivations always succeed, so a
// failed smoke still leaves them; the job uploads them as an artifact).
// A check whose output didn't appear is built once more before it counts
// (a hung build fails at the daemon's timeout = 900).
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SOURCES } from "../../shared/sources.ts";
import { packageOf, partArg, testPart, TEST_PARTS } from "../lib/parts.ts";
import { tryRun, writeJson } from "../lib/util.ts";

export const BRANCH_ONLY = new Set(["nix-format"]);
/** The flake's package names, from its pins (shared/sources.ts). */
export const PACKAGES = SOURCES.flatMap((s) => Object.keys(s.packages));

export interface Check { out: string; drv: string }
export const CHECKS_APPLY = "builtins.mapAttrs (_: c: { out = c.outPath; drv = c.drvPath; })";

/** The checks SET runs, before the part filter. */
export function inScope(set: string, names: string[], differs: (name: string) => boolean = () => false): string[] {
  const source = SOURCES.find((s) => s.repo === set);
  return names.filter((n) => {
    if (n.endsWith("-run")) return false; // built as the smoke checks' inputs
    if (BRANCH_ONLY.has(n) && set !== "branch") return false;
    // nixpkgs-stable changes no default check: like a repository with no
    // packages, its flake-wide checks and any whose derivation isn't main's
    // (the rest inherited from main, narrow.ts).
    if (set === "nixpkgs-stable") return n !== "default-build" && (packageOf(n, PACKAGES) === null || differs(n));
    if (!source) return true; // candidate, final, main, branch, nixpkgs
    // default-build runs in the full suites only: its derivation is every
    // input's, and an input alone would download everything for it.
    if (n === "default-build") return false;
    const own = packageOf(n, PACKAGES);
    // That repository's checks, every flake-wide one, and any whose
    // derivation isn't main's.
    return !own || Object.hasOwn(source.packages, own) || differs(n);
  });
}

export interface Nix {
  /** The checks of the working tree, or of a commit (`rev`). */
  evaluate(system: string, rev?: string): Record<string, Check> | null;
  /** Build; true when the build was cut short (a timeout, a signal, or it
   * never started): then what it didn't build has no verdict. */
  build(system: string, names: string[]): boolean | void;
  valid(path: string): boolean;
  /** Delete an output, so building it again reruns it. */
  forget(path: string): void;
}
export const nix: Nix = {
  evaluate(system, rev) {
    // A commit is unpacked from git (`git archive`) and read as a path:
    // flake: Nix refuses a pinned revision of a shallow clone, and the CI
    // checkouts are shallow.
    let dir: string | null = null;
    if (rev) {
      dir = mkdtempSync(join(tmpdir(), "test-base-"));
      const u = tryRun("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", rev, dir]);
      if (u.status !== 0) {
        console.error(`couldn't unpack ${rev}: ${u.stderr}`);
        rmSync(dir, { recursive: true, force: true });
        return null;
      }
    }
    const flake = dir ? `path:${dir}` : ".";
    const r = tryRun("nix", ["eval", "--json", `${flake}#checks.${system}`, "--apply", CHECKS_APPLY], { timeout: 20 * 60_000 });
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (r.status !== 0) {
      console.error(r.stderr);
      return null;
    }
    return JSON.parse(r.stdout);
  },
  build(system, names) {
    if (!names.length) return false;
    // --keep-going: one failure doesn't stop the rest; the exit status is
    // read from the outputs instead.
    const r = tryRun("nix", ["build", "--keep-going", "--no-link", "-L", ...names.map((n) => `.#checks.${system}.${n}`)], { stdio: ["ignore", "inherit", "inherit"], timeout: 75 * 60_000 });
    if (r.status !== 0) console.error(`nix build exited with ${r.status}${r.cut ? " (cut short)" : ""}`);
    return !!r.cut;
  },
  valid: (path) => tryRun("nix-store", ["--check-validity", path]).status === 0,
  forget: (path) => { tryRun("nix-store", ["--delete", path]); },
};

/** The commit the working tree's changes are on (the candidate's base). */
export const baseRev = () => tryRun("git", ["rev-parse", "HEAD"]).stdout;

export interface Result {
  set: string;
  system: string;
  part: string | null;
  /** The tree tested: HEAD's, with the working tree's versions/ and
   * flake.lock (where candidates differ). */
  tree: string;
  /** Every check ran and left evidence. */
  complete: boolean;
  checked: string[];
  failed: string[];
  /** Checks with no evidence either way (a smoke that left no output: a
   * dependency or daemon failure); they make the result incomplete. */
  incomplete: string[];
  drvs: Record<string, string>;
  /** The tree's check names before any input or part filtering, less the
   * `-run` derivations and, outside branch CI, the branch-only checks: an
   * input alone inherits main's verdicts only for these (narrow.ts
   * effective); a check its tree no longer has (a package marked
   * unavailable) isn't its. */
  present?: string[];
}

/** The tree this job tests (see Result.tree). */
export function workingTree(): string {
  const index = join(mkdtempSync(join(tmpdir(), "test-tree-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    tryRun("git", ["read-tree", "HEAD"], { env });
    tryRun("git", ["add", "-A", "--", "versions", "flake.lock"], { env });
    return tryRun("git", ["write-tree"], { env }).stdout;
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}

export function runSuite(set: string, system: string, part: string | undefined, n: Nix = nix, tree = ""): { result: Result; checks: Record<string, Check> } {
  const empty = (checks: Record<string, Check>) => ({ result: { set, system, part: part ?? null, tree, complete: false, checked: [], failed: [], incomplete: [], drvs: {} }, checks });
  const checks = n.evaluate(system);
  if (!checks) return empty({});
  // An input alone: main's derivations, from the base commit.
  let differs = (_: string) => false;
  if (SOURCES.some((x) => x.repo === set) || set === "nixpkgs-stable") {
    const base = n.evaluate(system, baseRev());
    if (!base) return empty(checks);
    differs = (c) => base[c]?.drv !== checks[c].drv;
  }
  const names = inScope(set, Object.keys(checks), differs).filter((c) => !part || testPart(c, PACKAGES) === part).sort();
  n.build(system, names);
  // Once more for what didn't appear (as in t3code-nix). A failed smoke's run
  // succeeded (it always does, recording the failure), so it's deleted first:
  // rebuilding the check then reruns the smoke itself.
  const missing = names.filter((c) => !n.valid(checks[c].out));
  for (const c of missing) {
    const run = checks[`${c}-run`];
    if (run && n.valid(run.out)) n.forget(run.out);
  }
  const cut = missing.length ? !!n.build(system, missing) : false;
  const failedNow = names.filter((c) => !n.valid(checks[c].out));
  // A smoke check whose run left no output at all has no evidence either
  // way; nor does anything a build that was cut short didn't build.
  const incomplete = failedNow.filter((c) => cut || (checks[`${c}-run`] && !n.valid(checks[`${c}-run`].out)));
  const failed = failedNow.filter((c) => !incomplete.includes(c));
  return {
    result: { set, system, part: part ?? null, tree, complete: incomplete.length === 0, checked: names, failed, incomplete, drvs: Object.fromEntries(names.map((c) => [c, checks[c].drv])),
      // The checks a suite of this set could run (branch-only ones only in
      // branch CI): what main can have a verdict on.
      present: Object.keys(checks).filter((c) => !c.endsWith("-run") && (set === "branch" || !BRANCH_ONLY.has(c))).sort() },
    checks,
  };
}

/** Copy each smoke's outputs (status, log, screenshot) for the artifact,
 * under smokes/<set>-<system>[-<part>]/<check>, so merged artifacts keep
 * both systems' apart. Not where the verdicts read results. */
export function collectSmokes(checks: Record<string, Check>, names: string[], out: string, scope: string, n: Nix = nix): string[] {
  const copied: string[] = [];
  for (const c of names) {
    const run = checks[`${c}-run`];
    if (!run || !n.valid(run.out)) continue;
    const dest = join(out, "smokes", scope, c);
    mkdirSync(dest, { recursive: true });
    cpSync(run.out, dest, { recursive: true, dereference: true });
    copied.push(c);
  }
  return copied;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [set, system, out] = argv.filter((a) => !a.startsWith("--"));
  if (!set || !system || !out) {
    console.error("usage: test.ts SET SYSTEM OUT_DIR [--part=PART]");
    process.exit(2);
  }
  const part = partArg(argv, TEST_PARTS);
  mkdirSync(out, { recursive: true });
  const scope = `${set}-${system}${part ? `-${part}` : ""}`;
  const { result, checks } = runSuite(set, system, part, nix, workingTree());
  collectSmokes(checks, result.checked.filter((c) => checks[`${c}-run`]), out, scope);
  writeJson(join(out, `result-${scope}.json`), result);
  console.log(`${set} ${system}${part ? ` (${part})` : ""}: ${result.checked.length} checks, ${result.failed.length} failed${result.failed.length ? `: ${result.failed.join(", ")}` : ""}${result.complete ? "" : ` (incomplete${result.incomplete.length ? `: no evidence for ${result.incomplete.join(", ")}` : ": the checks didn't evaluate"})`}`);
  // The job fails only when it couldn't produce a complete result: a check
  // failing is a verdict, read from the file, not an infrastructure failure
  // (the issues job counts failed jobs as update-failed).
  process.exit(result.complete ? 0 : 1);
}
