// Candidates: the base commit plus a set of inputs, moved between jobs as an
// artifact so every architecture tests exactly the same thing. An input is
// one repository release (versions/<repo>.json, every package from it) or
// the nixpkgs bump (flake.lock, input name "nixpkgs"). As in t3code-nix.
// With nothing else new, a NixOS-stable snapshot that lags main's releases
// is an input of its own, `stable-snapshot`, with no files: the run tests
// main's tree, and publish moves the snapshot only if stable-next passes.
//
//   node candidate.ts make DIR [OBS]   save the working tree's changed pins
//                                      and nixpkgs bump (after `update.ts
//                                      --write`) into DIR
//   node candidate.ts apply DIR [NAMES]
//                                      copy the inputs (all, or NAMES) into
//                                      the working tree
//   node candidate.ts tree DIR [NAMES] the tree hash of the base commit plus
//                                      exactly those inputs' files
//   node candidate.ts names DIR        the input names, comma-separated
//
// DIR holds inputs.json ({base, inputs: [{name, files, from, to, why,
// fingerprint}]}) and files/<path> for every changed file. The status page
// (status-reads.ts) reads inputs.json's names and `to` from the artifact.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sourceOf } from "../../shared/sources.ts";
import { Failed, git, nixpkgsRev, readJson, run, tryRun, writeJson, type Pin } from "../lib/util.ts";
import { behind, hasSnapshot, SNAPSHOT_INPUT } from "../lib/snapshot.ts";
import { pinFingerprint, type Observation } from "../update.ts";
import { readHeld } from "./held.ts";

export interface Input {
  name: string;
  files: string[];
  from: string | null;
  to: string | null;
  /** The release's fingerprint (a repository input), for holds. */
  fingerprint?: string;
  /** What sort of input it is (see KINDS); derived from the name for an
   * inputs.json written without it. */
  kind?: InputKind;
  /** Only main's own release's `unavailable` marker moves (kind "marker"). */
  markerOnly?: boolean;
}
export { SNAPSHOT_INPUT };

/** The sorts of input, and what each may do. Every consumer (narrow.ts's
 * plan, decide and verdict; publish.ts) asks this table, never the name.
 * - release: a repository release; marker: main's own release with only its
 *   `unavailable` marker moved; nixpkgs: the flake.lock bump;
 *   stable-pin: versions/nixpkgs-stable.json; stable-marker: a snapshot
 *   pin's marker; catch-up: the file-less snapshot catch-up. */
export type InputKind = "release" | "marker" | "nixpkgs" | "stable-pin" | "stable-marker" | "catch-up";
export interface KindRules {
  /** A failure of its own can hold it (test-failed, combination-failed). */
  holdable: boolean;
  /** Its landing is test-passed for it (closing its holds). */
  passes: boolean;
  /** Narrowing tests it alone; otherwise it takes main's result. */
  ownJob: boolean;
  /** It changes what NixOS stable builds (published.stableChanged). */
  changesStable: boolean;
  /** Gated on NixOS stable too: it passes only with no new stable failure,
   * and its narrowing job runs the stable group. */
  stableGated: boolean;
  /** Its version moving needs a release name (lib/releases.ts). */
  releases: boolean;
}
export const KINDS: Record<InputKind, KindRules> = {
  release: { holdable: true, passes: true, ownJob: true, changesStable: false, stableGated: false, releases: true },
  marker: { holdable: false, passes: false, ownJob: true, changesStable: false, stableGated: false, releases: true },
  nixpkgs: { holdable: true, passes: true, ownJob: true, changesStable: false, stableGated: false, releases: false },
  "stable-pin": { holdable: true, passes: true, ownJob: true, changesStable: true, stableGated: true, releases: false },
  "stable-marker": { holdable: false, passes: false, ownJob: false, changesStable: true, stableGated: false, releases: false },
  "catch-up": { holdable: false, passes: false, ownJob: false, changesStable: false, stableGated: false, releases: false },
};
export function kindOf(i: Pick<Input, "name" | "kind" | "markerOnly">): InputKind {
  if (i.kind) return i.kind;
  if (i.name === SNAPSHOT_INPUT) return "catch-up";
  if (i.name === "nixpkgs-stable") return "stable-pin";
  if (i.name === "nixpkgs") return "nixpkgs";
  if (i.name.startsWith("stable-")) return "stable-marker";
  return i.markerOnly ? "marker" : "release";
}
export const rules = (i: Pick<Input, "name" | "kind" | "markerOnly">): KindRules => KINDS[kindOf(i)];
export interface Candidate {
  base: string;
  inputs: Input[];
}

const showJson = (rev: string, path: string): any => {
  try { return JSON.parse(git("show", `${rev}:${path}`)); } catch { return null; }
};

/** The held releases (HELD_JSON), as "repo\0fingerprint". */
function heldKeys(): Set<string> {
  return new Set(readHeld(process.env.HELD_JSON).holds.map((h) => `${h.repo}\0${h.fingerprint}`));
}

/** Only the marker or nothing that moves bytes: never held. */
const markerOnly = (old: Pin | null, next: Pin) => !!old && old.tag === next.tag
  && JSON.stringify(old.packages) === JSON.stringify(next.packages);

/** Save the candidate. An input is held when an open issue holds its exact
 * release (fingerprint). A candidate tests held inputs only when all its
 * inputs are held (a run with nothing new retries them); otherwise every
 * held one is left out, reverted, and reported `held` in obsFile. */
export function make(out: string, obsFile?: string): string[] {
  const held = heldKeys();
  const changed = new Set([
    ...git("diff", "--name-only", "HEAD", "--", "versions", "flake.lock").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", "versions").split("\n"),
  ].filter(Boolean));
  const found: { input: Input; held: boolean }[] = [];
  for (const path of [...changed].sort()) {
    let input: Input, isHeld: boolean;
    if (/^versions\/stable\/[a-z0-9-]+\.json$/.test(path)) {
      // The NixOS-stable snapshot moves only in publish, after stable-next
      // passes. The one change resolve makes there is a pin's
      // `unavailable` marker (update.ts stableChecks): allowed alone.
      const old = showJson("HEAD", path), next = readJson(path);
      const { unavailable: a, ...restOld } = old ?? {};
      const { unavailable: b, ...restNext } = next ?? {};
      if (!old || JSON.stringify(restOld) !== JSON.stringify(restNext)) {
        throw new Failed(`${path} changed beyond its unavailable marker: only the publish job moves the NixOS-stable snapshot`);
      }
      input = { name: `stable-${basename(path, ".json")}`, kind: "stable-marker", files: [path], from: old.version, to: next.version };
      isHeld = false;
      found.push({ input, held: isHeld });
      void a; void b;
      continue;
    }
    if (path === "versions/nixpkgs-stable.json") {
      const old = showJson("HEAD", path), next = readJson(path);
      input = { name: "nixpkgs-stable", kind: "stable-pin", files: [path], from: old?.rev ?? null, to: next.rev ?? null, fingerprint: next.rev ?? undefined };
      isHeld = held.has(`nixpkgs-stable\0${input.to}`);
      found.push({ input, held: isHeld });
      continue;
    }
    if (path === "flake.lock") {
      // The revision is the bump's identity, for holds too.
      const to = nixpkgsRev(readJson(path));
      input = { name: "nixpkgs", kind: "nixpkgs", files: [path], from: nixpkgsRev(showJson("HEAD", path)), to, ...(to ? { fingerprint: to } : {}) };
      isHeld = held.has(`nixpkgs\0${input.to}`);
    } else if (/^versions\/[a-z0-9-]+\.json$/.test(path)) {
      const repo = basename(path, ".json");
      const source = sourceOf(repo);
      const old = showJson("HEAD", path) as Pin | null, next = readJson(path) as Pin;
      const fingerprint = pinFingerprint(source, next);
      const marker = markerOnly(old, next);
      input = { name: repo, kind: marker ? "marker" : "release", files: [path], from: old?.version ?? null, to: next.version, fingerprint, ...(marker ? { markerOnly: true } : {}) };
      isHeld = held.has(`${repo}\0${fingerprint}`) && !marker;
    } else {
      throw new Failed(`unexpected changed file ${path}`);
    }
    found.push({ input, held: isHeld });
  }
  const retry = found.length > 0 && found.every((f) => f.held);
  // A run with nothing new (idle, or retrying held releases) catches a
  // lagging snapshot up, unless stable-next already turned this very tree
  // down with complete results (held.ts's snapshotStuck): then it waits for
  // main to move.
  if (!found.length || retry) {
    const head = git("rev-parse", "HEAD^{tree}");
    // The same judgement as publish's stable-behind (behind()): a marker
    // that differs is lag too, and the catch-up copies main's.
    const lagging = readHeld(process.env.HELD_JSON).snapshotStuck.includes(head) ? [] : behind(head);
    if (lagging.length) {
      console.error(`candidate: the NixOS-stable snapshot lags for ${lagging.join(", ")}; catching it up`);
      found.push({ input: { name: SNAPSHOT_INPUT, kind: "catch-up", files: [], from: null, to: null }, held: false });
    }
  }
  const inputs: Input[] = [];
  const left: Observation[] = [];
  // The snapshot already main's pins (a hand repair, say): say so, so a
  // stable-behind closes without a publish (a publish's stable-behind in the
  // same run wins).
  const headTree = git("rev-parse", "HEAD^{tree}");
  if (hasSnapshot(headTree) && !behind(headTree).length) left.push({ kind: "stable-current", repo: null, version: null, detail: "" });
  for (const { input, held: isHeld } of found) {
    if (isHeld && !retry) {
      console.error(`candidate: ${input.name} ${input.to} is held by an open issue; left out`);
      for (const path of input.files) {
        if (tryRun("git", ["cat-file", "-e", `HEAD:${path}`]).status === 0) git("checkout", "-q", "HEAD", "--", path);
        else rmSync(path);
      }
      left.push({ kind: "held", repo: input.name, version: input.to, detail: "an open issue holds this release", ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}) });
      continue;
    }
    for (const path of input.files) {
      mkdirSync(dirname(join(out, "files", path)), { recursive: true });
      copyFileSync(path, join(out, "files", path));
    }
    inputs.push(input);
  }
  mkdirSync(out, { recursive: true });
  writeJson(join(out, "inputs.json"), { base: git("rev-parse", "HEAD"), inputs } satisfies Candidate);
  if (obsFile) writeJson(obsFile, { observations: left });
  return inputs.map((i) => i.name);
}

export const load = (dir: string): Candidate => readJson(join(dir, "inputs.json"));

export function chosen(c: Candidate, names?: string | null): Input[] {
  const wanted = names == null ? new Set(c.inputs.map((i) => i.name)) : new Set(names.split(",").filter(Boolean));
  for (const n of wanted) if (!c.inputs.some((i) => i.name === n)) throw new Failed(`no input ${n} in the candidate`);
  return c.inputs.filter((i) => wanted.has(i.name));
}

/** Copy the chosen inputs' files into the working tree. */
export function apply(dir: string, names?: string | null): void {
  for (const input of chosen(load(dir), names)) {
    for (const path of input.files) {
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(dir, "files", path), path);
    }
  }
}

/** The tree of the base commit plus exactly the chosen inputs' files,
 * written into the repository's objects (so stable.ts can unpack it). */
export function tree(dir: string, names?: string | null): string {
  const c = load(dir);
  const index = join(mkdtempSync(join(tmpdir(), "candidate-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run("git", ["read-tree", c.base], { env });
    for (const input of chosen(c, names)) {
      for (const path of input.files) {
        const blob = run("git", ["hash-object", "-w", join(dir, "files", path)]);
        run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
    }
    return run("git", ["write-tree"], { env });
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [cmd, dir, names] = process.argv.slice(2);
  if (cmd === "make" && dir) console.log(make(dir, names).join(","));
  else if (cmd === "apply" && dir) apply(dir, names ?? null);
  else if (cmd === "tree" && dir) console.log(tree(dir, names ?? null));
  else if (cmd === "names" && dir) console.log(load(dir).inputs.map((i) => i.name).join(","));
  else {
    console.error("usage: candidate.ts make|apply|tree|names DIR [NAMES|OBS]");
    process.exit(2);
  }
}

export const readText = (p: string) => readFileSync(p, "utf8");
