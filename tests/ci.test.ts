// The update workflow's plumbing: parts, test scoping, merging parts,
// narrowing, issues (holds by fingerprint, closing evidence), candidates and
// the hourly backstop. As in t3code-nix's ci.test.ts, adapted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appParts, packageOf, testPart, TEST_PARTS } from "../scripts/lib/parts.ts";
import { BRANCH_ONLY, inScope, PACKAGES, runSuite, type Nix } from "../scripts/ci/test.ts";
import { merge } from "../scripts/ci/merge-parts.ts";
import { decide, load, outcome, plan, verdict } from "../scripts/ci/narrow.ts";
import * as narrowMod from "../scripts/ci/narrow.ts";
import { SCHEDULED } from "../scripts/ci/reconcile.ts";
import { apply, heldReleases, incompleteReason, metaOf } from "../scripts/ci/issues.ts";
import { assess } from "../scripts/ci/health.ts";
import { regressions } from "../scripts/ci/stable.ts";
import { SOURCES } from "../shared/sources.ts";
import { Fake } from "./fake-gh.ts";

const ALL_CHECKS = [
  ...PACKAGES.flatMap((p) => [`${p}-version`, `${p}-libs`, `${p}-files`, `${p}-smoke`, `${p}-smoke-run`]),
  "anicraft-smoke-gl", "pdfcraft-cli-job", "aggregate", "module-eval", "default-build", "unit", "nix-format", "nix-lint", "as-shipped",
];

test("parts: every app's checks together, Studio alone, default-build alone, flake-wide in `flake`; apps spread by size", () => {
  const parts = appParts();
  for (const p of PACKAGES.filter((x) => !["artcraft-studio", "pdfcraft-cli", "figcraft-server"].includes(x))) {
    const where = new Set(ALL_CHECKS.filter((c) => packageOf(c, PACKAGES) === p).map((c) => testPart(c, PACKAGES, parts)));
    assert.equal(where.size, 1, `${p}'s checks are in one part`);
  }
  assert.equal(testPart("artcraft-studio-smoke", PACKAGES, parts), "studio");
  assert.equal(testPart("default-build", PACKAGES, parts), "default-build");
  assert.equal(testPart("aggregate", PACKAGES, parts), "flake");
  // pdfcraft-cli is a companion (flake), not pdfcraft's.
  assert.equal(packageOf("pdfcraft-cli-job", PACKAGES), "pdfcraft-cli");
  assert.equal(testPart("pdfcraft-cli-job", PACKAGES, parts), "flake");
  const counts = new Map<string, number>();
  for (const [, part] of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
  assert.deepEqual([...counts.keys()].sort(), ["apps1", "apps2", "apps3"]);
  assert.deepEqual(appParts(), parts, "deterministic");
});

test("scoping: an input alone runs its repository's checks, the flake-wide ones and any whose derivation differs; nix-format and nix-lint in branch CI only", () => {
  const pdf = inScope("pdfcraft", ALL_CHECKS);
  assert.ok(pdf.includes("pdfcraft-smoke") && pdf.includes("pdfcraft-cli-job") && pdf.includes("aggregate"));
  assert.ok(!pdf.includes("photocraft-smoke"));
  assert.ok(!pdf.some((c) => c.endsWith("-run")));
  assert.ok(inScope("pdfcraft", ALL_CHECKS, (c) => c === "photocraft-files").includes("photocraft-files"));
  assert.equal(inScope("nixpkgs", ALL_CHECKS).length, inScope("main", ALL_CHECKS).length);
  assert.deepEqual([...BRANCH_ONLY].sort(), ["nix-format", "nix-lint"]);
  // Every branch-only name is a real check (lib/checks.nix defines it).
  const checksNix = readFileSync(join(import.meta.dirname, "..", "lib", "checks.nix"), "utf8");
  for (const name of BRANCH_ONLY) assert.match(checksNix, new RegExp(`\\n  ${name} =\\n`), `${name} is a check`);
  for (const c of ["nix-format", "nix-lint"]) {
    assert.ok(!inScope("candidate", ALL_CHECKS).includes(c));
    assert.ok(inScope("branch", ALL_CHECKS).includes(c));
  }
});

test("runSuite: a build cut short (a timeout) leaves what it didn't build incomplete, never failed", () => {
  const checks = Object.fromEntries(ALL_CHECKS.map((c) => [c, { out: `/o/${c}`, drv: `/d/${c}` }]));
  const nix: Nix = { evaluate: () => checks, build: () => true, valid: () => false, forget: () => {} };
  const { result } = runSuite("candidate", "x86_64-linux", "default-build", nix);
  assert.deepEqual([result.complete, result.failed], [false, []]);
  assert.ok(result.incomplete.includes("default-build"));
});

test("runSuite: a check whose output didn't appear is built once more before it counts; an input alone evaluates main's too", () => {
  const built: string[][] = [];
  const valid = new Set<string>();
  let evaluations = 0;
  const checks = Object.fromEntries(ALL_CHECKS.map((c) => [c, { out: `/o/${c}`, drv: `/d/${c}` }]));
  const nix: Nix = {
    evaluate: (_s, rev) => { evaluations++; return rev !== undefined ? { ...checks, "photocraft-files": { out: "x", drv: "/other" } } : checks; },
    build: (_s, names) => { built.push(names); for (const n of names) if (built.length > 1 || n !== "pdfcraft-smoke") valid.add(`/o/${n}`); },
    valid: (p) => valid.has(p),
    forget: () => {},
  };
  const { result } = runSuite("pdfcraft", "x86_64-linux", undefined, nix);
  assert.equal(evaluations, 2);
  assert.deepEqual(built[1], ["pdfcraft-smoke"]);
  assert.deepEqual(result.failed, []);
  assert.ok(result.checked.includes("photocraft-files"), "its derivation isn't main's");
});

type R = { complete?: boolean; failed?: string[]; checked?: string[]; tree?: string; incomplete?: string[]; present?: string[] };
function results(entries: Record<string, R | null>) {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  for (const [key, r] of Object.entries(entries)) {
    if (!r) continue;
    const [set, system] = key.split("@");
    writeFileSync(join(dir, `result-${set}-${system}.json`), JSON.stringify({ set, system, part: null, tree: r.tree ?? `tree-${set}`, complete: r.complete ?? true,
      checked: r.checked ?? r.failed ?? [], failed: r.failed ?? [], incomplete: r.incomplete ?? [], drvs: {}, ...(r.present ? { present: r.present } : {}) }));
  }
  return dir;
}
const both = (set: string, r: R) => ({ [`${set}@x86_64-linux`]: r, [`${set}@aarch64-linux`]: r });
const inputs = [
  { name: "photocraft", files: [], from: "1", to: "2", fingerprint: "fp-photo" },
  { name: "figcraft", files: [], from: "1", to: "2", fingerprint: "fp-fig" },
];

test("narrowing: an input alone inherits main's verdicts only for checks its tree has; main incomplete elsewhere doesn't block it", () => {
  // photocraft's marker: its checks are gone from the marker's tree.
  const marker = { name: "photocraft", kind: "marker" as const, files: [], from: "1", to: "1", fingerprint: "fp", markerOnly: true };
  const fig = inputs[1];
  const alone = { checked: ["aggregate"], present: ["aggregate", "gridcraft-smoke"] };
  // Main failed photocraft's smoke (complete): not inherited by the marker.
  const d1 = decide([marker, fig], load(results({ ...both("main", { checked: ["photocraft-smoke", "gridcraft-smoke", "aggregate"], failed: ["photocraft-smoke"] }),
    ...both("photocraft", alone), ...both("figcraft", { checked: ["figcraft-smoke", "photocraft-smoke"] }) })));
  assert.ok(d1.final.includes("photocraft"), JSON.stringify(d1));
  assert.ok(!d1.observations.some((o) => o.kind === "env-broken"));
  // Main couldn't build photocraft's smoke (incomplete there only): the
  // marker needs no verdict on it.
  const d2 = decide([marker, fig], load(results({ ...both("main", { complete: false, checked: ["gridcraft-smoke", "aggregate"], incomplete: ["photocraft-smoke"] }),
    ...both("photocraft", alone), ...both("figcraft", { checked: ["figcraft-smoke"] }) })));
  assert.ok(d2.final.includes("photocraft"), JSON.stringify(d2));
  // A skipped check main has no verdict on: incomplete, as before.
  const d3 = decide([marker, fig], load(results({ ...both("main", { complete: false, checked: ["aggregate"], incomplete: ["gridcraft-smoke"] }),
    ...both("photocraft", alone), ...both("figcraft", { checked: ["figcraft-smoke"] }) })));
  assert.ok(!d3.final.includes("photocraft"));
});

test("narrowing, from real results: main incomplete only on a check the marker's tree lacks doesn't block the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "real-"));
  // Main's tree: PhotoCraft's smoke among the checks, and nix-format (branch only).
  const mainChecks = Object.fromEntries(["aggregate", "default-build", "gridcraft-version", "photocraft-smoke", "photocraft-smoke-run", "nix-format"].map((c) => [c, { out: `/o/${c}`, drv: `/d/${c}` }]));
  const markerChecks = Object.fromEntries(Object.entries(mainChecks).filter(([c]) => !c.startsWith("photocraft")));
  // PhotoCraft's smoke left no output in main: incomplete there only.
  const valid = (p: string) => !p.includes("photocraft");
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    for (const part of TEST_PARTS) {
      const nix: Nix = { evaluate: () => mainChecks, build: () => {}, valid, forget: () => {} };
      writeFileSync(join(dir, `result-main-${system}-${part}.json`), JSON.stringify(runSuite("main", system, part, nix, "tree-main").result));
    }
    const alone: Nix = { evaluate: () => markerChecks, build: () => {}, valid: () => true, forget: () => {} };
    writeFileSync(join(dir, `result-photocraft-${system}.json`), JSON.stringify(runSuite("photocraft", system, undefined, alone, "tree-photocraft").result));
  }
  merge(dir, () => {});
  const sets = load(dir);
  assert.equal(outcome(sets, "main"), "incomplete");
  assert.equal(outcome(sets, "photocraft", null, true), "pass");
  // An input that runs its tree's every check (the nixpkgs bump) needs no
  // main at all.
  const all = mkdtempSync(join(tmpdir(), "all-"));
  const every: Nix = { evaluate: () => markerChecks, build: () => {}, valid: () => true, forget: () => {} };
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    writeFileSync(join(all, `result-nixpkgs-${system}.json`), JSON.stringify(runSuite("nixpkgs", system, undefined, every, "tree-nixpkgs").result));
  }
  assert.equal(outcome(load(all), "nixpkgs", null, true), "pass", "no main results at all");
});

test("merge-parts: complete only with every part there and complete; failures the union", () => {
  const dir = mkdtempSync(join(tmpdir(), "parts-"));
  for (const part of TEST_PARTS) {
    writeFileSync(join(dir, `result-candidate-x86_64-linux-${part}.json`), JSON.stringify({ set: "candidate", system: "x86_64-linux", part, complete: true, checked: [`${part}-a`], failed: part === "studio" ? ["artcraft-studio-smoke"] : [], drvs: {} }));
    if (part !== "flake") writeFileSync(join(dir, `result-candidate-aarch64-linux-${part}.json`), JSON.stringify({ set: "candidate", system: "aarch64-linux", part, complete: true, checked: [], failed: [], drvs: {} }));
  }
  merge(dir, () => {});
  const x = JSON.parse(readFileSync(join(dir, "result-candidate-x86_64-linux.json"), "utf8"));
  const a = JSON.parse(readFileSync(join(dir, "result-candidate-aarch64-linux.json"), "utf8"));
  assert.deepEqual([x.complete, x.failed], [true, ["artcraft-studio-smoke"]]);
  assert.equal(a.complete, false, "a part is missing");
});

test("narrowing: a passing candidate needs none; with one input only main is tested, and its result is the candidate's", () => {
  assert.equal(plan(inputs, load(results(both("candidate", {})))), null);
  assert.deepEqual(plan(inputs, load(results(both("candidate", { failed: ["x"] })))), ["main", "photocraft", "figcraft"]);
  assert.deepEqual(plan([inputs[0]], load(results(both("candidate", { failed: ["x"] })))), ["main"]);
  const d = decide([inputs[0]], load(results({ ...both("candidate", { failed: ["photocraft-smoke"] }), ...both("main", {}) })));
  assert.deepEqual(d.final, []);
  assert.ok(d.observations.some((o) => o.kind === "test-failed" && o.fingerprint === "fp-photo"));
  // Main's ARM leg timed out: the failure may be the environment's, no hold.
  const noBase = decide([inputs[0]], load(results({ ...both("candidate", { failed: ["photocraft-smoke"] }), "main@x86_64-linux": {}, "main@aarch64-linux": null })));
  assert.ok(!noBase.observations.some((o) => o.kind === "test-failed"));
  assert.ok(noBase.observations.some((o) => o.kind === "update-failed"));
});

test("env-broken only when main fails and every input fails too", () => {
  const all = load(results({ ...both("main", { failed: ["module-eval"] }), ...both("photocraft", { failed: ["module-eval"] }), ...both("figcraft", { failed: ["module-eval"] }) }));
  const d = decide(inputs, all);
  assert.deepEqual(d.final, []);
  assert.deepEqual(d.observations.map((o) => o.kind), ["env-broken"]);
});

test("main fails and one input passes: that input publishes (a change that fixes main gets through)", () => {
  const d = decide(inputs, load(results({ ...both("main", { failed: ["photocraft-smoke"] }), ...both("photocraft", { checked: ["photocraft-smoke"] }), ...both("figcraft", { failed: ["figcraft-smoke"] }) })));
  assert.deepEqual(d.final, ["photocraft"]);
  assert.ok(d.observations.some((o) => o.kind === "test-failed" && o.repo === "figcraft" && o.fingerprint === "fp-fig"));
  assert.ok(!d.observations.some((o) => o.kind === "env-broken"));
});

test("a missing result is update-failed, holds nothing, and never makes env-broken", () => {
  const d = decide(inputs, load(results({ ...both("main", { failed: ["x"] }), ...both("photocraft", { failed: ["x"] }), "figcraft@x86_64-linux": { failed: ["y"] }, "figcraft@aarch64-linux": null })));
  assert.ok(!d.observations.some((o) => o.kind === "env-broken"));
  assert.ok(d.observations.some((o) => o.kind === "update-failed"));
  assert.ok(!d.observations.some((o) => o.kind === "test-failed" && o.repo === "figcraft"));
  assert.equal(outcome(load(results({ "x@x86_64-linux": {} })), "x"), "incomplete");
});

test("an input alone inherits main's verdict for each check it skipped, so main's failure is never a combination's", () => {
  const sets = load(results({ ...both("main", { failed: ["photocraft-smoke"], checked: ["photocraft-smoke", "figcraft-smoke"] }),
    ...both("figcraft", { checked: ["figcraft-smoke"] }), ...both("photocraft", { checked: ["photocraft-smoke"] }) }));
  const d = decide(inputs, sets);
  assert.deepEqual(d.final, ["photocraft"], "photocraft fixes main's failure");
  assert.ok(d.observations.some((o) => o.kind === "test-failed" && o.repo === "figcraft" && /photocraft-smoke/.test(o.detail)));
  // Without main's result, an input alone is incomplete.
  const noMain = decide(inputs, load(results({ ...both("figcraft", {}), ...both("photocraft", {}) })));
  assert.deepEqual(noMain.final, []);
  assert.ok(!noMain.observations.some((o) => o.kind === "test-failed"));
});

test("a failure on one system while the other's result is missing is incomplete, never a hold; a result of another tree doesn't count", () => {
  const one = load(results({ "candidate@x86_64-linux": { failed: ["x"] } }));
  assert.equal(outcome(one, "candidate"), "incomplete");
  const wrongTree = load(results(both("candidate", { tree: "other" })));
  assert.equal(outcome(wrongTree, "candidate", new Map([["candidate", "expected"]])), "incomplete");
  assert.equal(outcome(wrongTree, "candidate", new Map([["candidate", "other"]])), "pass");
});

test("input kinds: markers and the catch-up take main's result and are never held; main failing alone holds none of them", async () => {
  const { kindOf, rules } = await import("../scripts/ci/candidate.ts");
  assert.deepEqual(["photocraft", "nixpkgs", "nixpkgs-stable", "stable-pdfcraft", "stable-snapshot"].map((name) => kindOf({ name })),
    ["release", "nixpkgs", "stable-pin", "stable-marker", "catch-up"]);
  assert.equal(kindOf({ name: "pdfcraft", markerOnly: true }), "marker");
  assert.ok(!rules({ name: "stable-snapshot" }).holdable && !rules({ name: "stable-pdfcraft" }).ownJob);
  const ins = [inputs[1], { name: "stable-pdfcraft", files: ["versions/stable/pdfcraft.json"], from: "0.2", to: "0.2" }, { name: "stable-snapshot", files: [], from: null, to: null }];
  // figcraft reran main's failing check and passes it: it fixes main.
  const d = decide(ins, load(results({ ...both("main", { failed: ["a"] }), ...both("figcraft", { checked: ["a", "figcraft-smoke"] }) })));
  assert.deepEqual(d.final, ["figcraft"]);
  assert.ok(!d.observations.some((o) => o.kind === "test-failed"), JSON.stringify(d.observations));
});

test("stable gating follows the kind, not the name", () => {
  const pin = { name: "renamed-pin", kind: "stable-pin" as const, files: ["versions/nixpkgs-stable.json"], from: "a", to: "b", fingerprint: "b" };
  // Default results pass, stable results missing: not a pass.
  assert.notEqual(plan([pin], load(results(both("candidate", {})))), null);
  assert.ok(narrowMod.legs(["main", "renamed-pin"], [pin]).some((l) => l.set === "renamed-pin" && l.stable));
});

test("verdict: a passing final publishes; a failing final holds its inputs as combination-failed", () => {
  {
    // Only main's release's marker moved: its failure holds nothing, and its
    // landing passes no release.
    const marker = [{ name: "pdfcraft", files: ["versions/pdfcraft.json"], from: "0.20.0", to: "0.20.0", fingerprint: "fp-main", markerOnly: true }];
    assert.deepEqual(verdict(marker, load(results(both("candidate", { failed: ["x"] }))), "candidate", ["pdfcraft"]).observations, []);
    const d = decide([...marker, inputs[1]], load(results({ ...both("main", {}), ...both("pdfcraft", { failed: ["pdfcraft-smoke"] }), ...both(inputs[1].name, {}) })));
    assert.ok(!d.observations.some((o) => o.kind === "test-failed" && o.repo === "pdfcraft"));
    assert.ok(d.observations.some((o) => o.kind === "update-failed" && /only its unavailable marker/.test(o.detail)));
  }
  {
    // The snapshot catch-up alone: main's tree failing holds nothing.
    const snap = [{ name: "stable-snapshot", files: [], from: null, to: null }];
    assert.deepEqual(verdict(snap, load(results(both("final", { failed: ["x"] }))), "final", ["stable-snapshot"]).observations.map((o) => [o.kind, o.repo]), [["update-failed", null]], "not silent");
    assert.deepEqual(verdict(snap, load(results(both("candidate", { failed: ["x"] }))), "candidate", ["stable-snapshot"]).observations, []);
  }
  const ok = verdict(inputs, load(results(both("final", {}))), "final", ["photocraft", "figcraft"]);
  assert.deepEqual([ok.ok, ok.observations], [true, []], "test-passed comes from publish, once landed");
  const bad = verdict(inputs, load(results(both("final", { failed: ["aggregate"] }))), "final", ["photocraft", "figcraft"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.observations.map((o) => [o.kind, o.fingerprint]), [["combination-failed", "fp-photo"], ["combination-failed", "fp-fig"]]);
});

test("issues: a hold records the release's fingerprint; a new fingerprint for the same version is a change", async () => {
  const gh = new Fake();
  await apply([{ kind: "test-failed", repo: "photocraft", version: "0.24.0", detail: "photocraft-smoke", fingerprint: "fp1" }], gh, new Date("2026-11-22T00:00:00Z"));
  assert.deepEqual(heldReleases(await gh.issues()), [{ repo: "photocraft", version: "0.24.0", fingerprint: "fp1" }]);
  await apply([{ kind: "integrity", repo: "photocraft", version: "0.24.0", detail: "bad signature", fingerprint: "fp2" }], gh, new Date("2026-11-22T00:05:00Z"));
  assert.equal(heldReleases(await gh.issues()).length, 2, "integrity holds too");
  // test-passed at the same version closes the test failure.
  await apply([{ kind: "test-passed", repo: "photocraft", version: "0.24.0", detail: "" }], gh, new Date("2026-11-22T00:10:00Z"));
  const open = (await gh.issues()).filter((i) => i.state === "open").map((i) => metaOf(i)!.key);
  assert.deepEqual(open, ["integrity/photocraft/-"]);
  // A pass (the pin verified) closes integrity.
  await apply([{ kind: "pass", repo: "photocraft", version: "0.24.1", detail: "" }], gh, new Date("2026-11-22T00:15:00Z"));
  assert.deepEqual((await gh.issues()).filter((i) => i.state === "open"), []);
});

test("issues: incomplete-release closes with the reason", async () => {
  assert.equal(incompleteReason("0.24.0", "0.24.0"), "0.24.0 became eligible");
  assert.equal(incompleteReason("0.24.0", "0.25.0"), "a higher release, 0.25.0, is eligible");
  assert.match(incompleteReason("0.24.0", "0.23.1"), /withdrawn/);
  const gh = new Fake();
  await apply([{ kind: "incomplete-release", repo: "figcraft", version: "0.19.0", detail: "missing x" }], gh, new Date("2026-11-22T00:00:00Z"));
  await apply([{ kind: "incomplete-ok", repo: "figcraft", version: "0.19.0", detail: "" }], gh, new Date("2026-11-22T01:00:00Z"));
  const [issue] = gh.issueList;
  assert.equal(issue.state, "closed");
  assert.match(issue.comments!.at(-1)!, /0.19.0 became eligible/);
});

test("issues: unavailable closes on `available` (main's own pin), not before", async () => {
  const gh = new Fake();
  await apply([{ kind: "unavailable", repo: "figcraft", version: "0.18.1", detail: "figcraft-server gone" }], gh, new Date("2026-11-22T00:00:00Z"));
  await apply([{ kind: "pass", repo: "figcraft", version: "0.18.1", detail: "" }], gh, new Date("2026-11-22T00:01:00Z"));
  assert.equal(gh.issueList[0].state, "open");
  await apply([{ kind: "available", repo: "figcraft", version: "0.18.1", detail: "" }], gh, new Date("2026-11-22T00:02:00Z"));
  assert.equal(gh.issueList[0].state, "closed");
});

function candidateRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, "versions"));
  for (const s of SOURCES) execFileSync("cp", [join(import.meta.dirname, "..", "versions", `${s.repo}.json`), join(dir, "versions")]);
  writeFileSync(join(dir, "flake.lock"), JSON.stringify({ nodes: { nixpkgs: { locked: { rev: "aaa" } } } }));
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return { dir, g };
}

test("candidate: a held release (its fingerprint) is left out unless every input is held; a held version with new assets isn't held", async () => {
  const { make } = await import("../scripts/ci/candidate.ts");
  const { pinFingerprint } = await import("../scripts/update.ts");
  const { sourceOf } = await import("../shared/sources.ts");
  const { dir } = candidateRepo();
  const bump = (repo: string, id: number) => {
    const p = JSON.parse(readFileSync(join(dir, "versions", `${repo}.json`), "utf8"));
    p.version = p.version.replace(/\d+$/, (n: string) => String(Number(n) + 1));
    p.packages[repo]["x86_64-linux"].assetId = id;
    writeFileSync(join(dir, "versions", `${repo}.json`), JSON.stringify(p));
    return pinFingerprint(sourceOf(repo), p);
  };
  const fpPhoto = bump("photocraft", 1);
  bump("gridcraft", 2);
  const held = join(dir, "held.json");
  writeFileSync(held, JSON.stringify([{ repo: "photocraft", version: "x", fingerprint: fpPhoto }]));
  const old = process.cwd();
  process.chdir(dir);
  process.env.HELD_JSON = held;
  try {
    const names = make(join(dir, "out"), join(dir, "obs.json"));
    assert.deepEqual(names, ["gridcraft"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "obs.json"), "utf8")).observations.map((o: any) => [o.kind, o.repo]), [["held", "photocraft"]]);
    // photocraft was reverted; with only it changed (and held), it's retried.
    bump("photocraft", 1);
    execFileSync("git", ["checkout", "-q", "--", "versions/gridcraft.json"]);
    assert.deepEqual(make(join(dir, "out2")), ["photocraft"]);
    // New assets for the held version: a new fingerprint, not held.
    execFileSync("git", ["checkout", "-q", "--", "versions/photocraft.json"]);
    bump("photocraft", 99);
    bump("gridcraft", 3);
    assert.deepEqual(make(join(dir, "out3")).sort(), ["gridcraft", "photocraft"]);
  } finally {
    process.chdir(old);
    delete process.env.HELD_JSON;
  }
});

test("candidate: an input whose only change is main's release's marker says so", async () => {
  const { make, load: loadCand } = await import("../scripts/ci/candidate.ts");
  const { dir } = candidateRepo();
  const p = JSON.parse(readFileSync(join(dir, "versions", "photocraft.json"), "utf8"));
  writeFileSync(join(dir, "versions", "photocraft.json"), JSON.stringify({ ...p, unavailable: { since: "x", issue: null, packages: ["photocraft"] } }));
  const old = process.cwd();
  process.chdir(dir);
  try {
    assert.deepEqual(make(join(dir, "out")), ["photocraft"]);
    assert.equal(loadCand(join(dir, "out")).inputs[0].markerOnly, true);
  } finally { process.chdir(old); }
});

test("candidate: the stable snapshot never changes in resolve", async () => {
  const { make } = await import("../scripts/ci/candidate.ts");
  const { dir } = candidateRepo();
  mkdirSync(join(dir, "versions", "stable"));
  writeFileSync(join(dir, "versions", "stable", "photocraft.json"), "{}");
  const old = process.cwd();
  process.chdir(dir);
  try { assert.throws(() => make(join(dir, "out")), /only the publish job/); } finally { process.chdir(old); }
});

test("candidate: with nothing else new, a snapshot lagging main's pins (a marker too) is the stable-snapshot input; once equal, stable-current", async () => {
  const { make } = await import("../scripts/ci/candidate.ts");
  const { dir, g } = candidateRepo();
  mkdirSync(join(dir, "versions", "stable"));
  const photo = JSON.parse(readFileSync(join(dir, "versions", "photocraft.json"), "utf8"));
  for (const s of SOURCES) execFileSync("cp", [join(dir, "versions", `${s.repo}.json`), join(dir, "versions", "stable")]);
  writeFileSync(join(dir, "versions", "stable", "photocraft.json"), JSON.stringify({ ...photo, unavailable: { since: "x", issue: null, packages: ["photocraft"] } }));
  g("add", "-A");
  g("commit", "-q", "-m", "snapshot, marked");
  const old = process.cwd();
  process.chdir(dir);
  try {
    assert.deepEqual(make(join(dir, "out"), join(dir, "obs0.json")), ["stable-snapshot"], "a marker that differs is lag, as publish judges it");
    assert.ok(!JSON.parse(readFileSync(join(dir, "obs0.json"), "utf8")).observations.some((o: any) => o.kind === "stable-current"), "behind by a marker: not current");
    // The snapshot exactly main's pins (a hand repair): stable-current.
    execFileSync("cp", [join(dir, "versions", "photocraft.json"), join(dir, "versions", "stable", "photocraft.json")]);
    g("commit", "-q", "-am", "repaired");
    make(join(dir, "out0"), join(dir, "obs1.json"));
    assert.ok(JSON.parse(readFileSync(join(dir, "obs1.json"), "utf8")).observations.some((o: any) => o.kind === "stable-current"));
    // In a run with something new too (a held retry that keeps failing).
    writeFileSync(join(dir, "versions", "gridcraft.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "versions", "gridcraft.json"), "utf8")), version: "9.9.7" }));
    make(join(dir, "out0b"), join(dir, "obs1b.json"));
    assert.ok(JSON.parse(readFileSync(join(dir, "obs1b.json"), "utf8")).observations.some((o: any) => o.kind === "stable-current"));
    g("checkout", "-q", "--", "versions/gridcraft.json");
    writeFileSync(join(dir, "versions", "stable", "photocraft.json"), JSON.stringify({ ...photo, version: "0.0.1" }));
    g("commit", "-q", "-am", "snapshot behind");
    assert.deepEqual(make(join(dir, "out2")), ["stable-snapshot"]);
    // stable-next already turned this tree down with complete results.
    const held = join(dir, "stuck.json");
    writeFileSync(held, JSON.stringify({ holds: [], waiting: [], snapshotStuck: [g("rev-parse", "HEAD^{tree}")] }));
    process.env.HELD_JSON = held;
    try { assert.deepEqual(make(join(dir, "out2b")), [], "not retried until main moves"); } finally { delete process.env.HELD_JSON; }
    // A held release retried alone: the catch-up goes with it.
    const { pinFingerprint } = await import("../scripts/update.ts");
    const { sourceOf } = await import("../shared/sources.ts");
    const fig = JSON.parse(readFileSync(join(dir, "versions", "figcraft.json"), "utf8"));
    fig.version = "9.9.8";
    fig.tag = "v9.9.8";
    writeFileSync(join(dir, "versions", "figcraft.json"), JSON.stringify(fig));
    writeFileSync(held, JSON.stringify({ holds: [{ repo: "figcraft", version: "9.9.8", fingerprint: pinFingerprint(sourceOf("figcraft"), fig) }], waiting: [] }));
    process.env.HELD_JSON = held;
    try { assert.deepEqual(make(join(dir, "out2c")), ["figcraft", "stable-snapshot"]); } finally { delete process.env.HELD_JSON; }
    g("checkout", "-q", "--", "versions/figcraft.json");
    // Anything else new: that run moves the snapshot if it can.
    writeFileSync(join(dir, "versions", "gridcraft.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "versions", "gridcraft.json"), "utf8")), version: "9.9.9" }));
    assert.deepEqual(make(join(dir, "out3")), ["gridcraft"]);
  } finally { process.chdir(old); }
});

test("NixOS stable: moveOf says whether its verdict is decided; open stable-behind issues name the stuck trees", async () => {
  const { moveOf } = await import("../scripts/ci/stable.ts");
  const { stuckTrees } = await import("../scripts/ci/issues.ts");
  const dir = mkdtempSync(join(tmpdir(), "move-"));
  const put = (system: string, group: string, r: object) => writeFileSync(join(dir, `stable-final-${system}-${group}.json`), JSON.stringify({ set: "final", system, group, tree: "T", complete: true, failed: [], ...r }));
  for (const s of ["x86_64-linux", "aarch64-linux"]) put(s, "stable", {});
  put("x86_64-linux", "next", { failed: ["stable-next-photocraft-smoke"], equivalent: true });
  assert.equal(moveOf(dir, "final", "T").decided, false, "one system missing");
  put("aarch64-linux", "next", { equivalent: false, equivalence: "the stable checks didn't evaluate", equivalenceUnknown: true });
  put("x86_64-linux", "next", { equivalent: false, equivalence: "the stable checks didn't evaluate", equivalenceUnknown: true });
  assert.equal(moveOf(dir, "final", "T").decided, false, "an evaluation error is no verdict");
  put("aarch64-linux", "next", { equivalent: true });
  put("x86_64-linux", "next", { failed: ["stable-next-photocraft-smoke"], equivalent: true });
  const m = moveOf(dir, "final", "T");
  assert.deepEqual([m.move, m.decided], [false, true]);
  const gh = new Fake();
  await apply([{ kind: "stable-behind", repo: null, version: null, detail: "lags", fingerprint: "tree:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], gh, new Date("2026-11-22T00:00:00Z"));
  assert.deepEqual(stuckTrees(gh.issueList as any), ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  // A hand-edited value is skipped, never a broken held file.
  const odd = new Fake();
  await apply([{ kind: "stable-behind", repo: null, version: null, detail: "lags", fingerprint: "tree:" }], odd, new Date("2026-11-22T00:00:00Z"));
  assert.deepEqual(stuckTrees(odd.issueList as any), []);
  // A later incomplete turn-down clears it: retried again.
  await apply([{ kind: "stable-behind", repo: null, version: null, detail: "lags, incomplete" }], gh, new Date("2026-11-22T01:00:00Z"));
  assert.deepEqual(stuckTrees(gh.issueList as any), []);
});

test("issues: resolve-failed closes per scope: main's pin by pass, the stable snapshot's by its own probe", async () => {
  const gh = new Fake();
  await apply([{ kind: "resolve-failed", repo: "pdfcraft", version: "0.20.0", detail: "probe failed", channel: "stable" },
    { kind: "resolve-failed", repo: "pdfcraft", version: null, detail: "read failed" }], gh, new Date("2026-11-22T00:00:00Z"));
  await apply([{ kind: "pass", repo: "pdfcraft", version: "0.21.1", detail: "" }], gh, new Date("2026-11-22T01:00:00Z"));
  const state = () => gh.issueList.map((i: any) => [i.body.includes("probe failed"), i.state]);
  assert.deepEqual(state(), [[true, "open"], [false, "closed"]]);
  // A budget skip of the NixOS channels' read (waiting) closes nothing.
  const ch = new Fake();
  await apply([{ kind: "resolve-failed", repo: "nixpkgs-stable", version: null, detail: "channels" }], ch, new Date("2026-11-22T00:00:00Z"));
  await apply([{ kind: "waiting", repo: "nixpkgs-stable", version: null, detail: "not enough time" }], ch, new Date("2026-11-22T01:00:00Z"));
  assert.equal(ch.issueList[0].state, "open");
  await apply([{ kind: "probed", repo: "pdfcraft", version: "0.20.0", detail: "", channel: "stable" }], gh, new Date("2026-11-22T02:00:00Z"));
  assert.deepEqual(state(), [[true, "closed"], [false, "closed"]]);
});

test("issues: every problem kind has evidence that closes it", async () => {
  const { CLOSES, PROBLEMS } = await import("../scripts/ci/issues.ts");
  const closable = new Set(Object.values(CLOSES).flatMap((r) => [r].flat().flatMap((x: any) => [...x.kinds])));
  // test-failed and combination-failed also close by `pass` (CLOSED_BY_PASS).
  assert.deepEqual([...PROBLEMS].filter((k) => !closable.has(k)), []);
});

test("health: a lower eligible release while the pin stands (it lost files) is no lag; a pulled pin's is", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const repo = (pinned: object) => ({ read: "2026-11-22T11:59:00Z", error: null, pinned, eligible: { tag: "v0.9.0", version: "0.9.0", firstSeen: "2026-11-22T09:00:00Z" } });
  const body = (pinned: object) => ({ deployed: "v1", state: { written: "2026-11-22T11:55:00Z", deployed: "v1", poll: {}, pins: {}, dispatch: {},
    repos: Object.fromEntries(SOURCES.map((s) => [s.repo, repo(pinned)])) } });
  const pins = Object.fromEntries(SOURCES.map((s) => [s.repo, { version: "1.0.0", tag: "v1.0.0" } as any]));
  const kinds = (pinned: object) => [...new Set(assess(body(pinned), null, pins, new Set(), now).filter((o) => o.repo === "photocraft").map((o) => o.kind))];
  assert.deepEqual(kinds({ tag: "v1.0.0", fingerprint: "x", pulled: false }), ["lag-ok"]);
  assert.deepEqual(kinds({ tag: "v1.0.0", fingerprint: "x", pulled: true }), ["update-lag"]);
});

test("dependabot: every composite action has its own entry", () => {
  const yml = readFileSync(join(import.meta.dirname, "..", ".github", "dependabot.yml"), "utf8");
  const listed = new Set([...yml.matchAll(/^\s+- (\/\S*)\s*$/gm)].map((m) => m[1]));
  const actions = execFileSync("ls", [join(import.meta.dirname, "..", ".github", "actions")], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const a of actions) assert.ok(listed.has(`/.github/actions/${a}`), `${a} is missing from dependabot.yml's directories`);
  assert.ok(listed.has("/"));
});

test("health: stale KV writes, a stale repository, auth, and update-lag after an hour", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const repos = Object.fromEntries(SOURCES.map((s) => [s.repo, { read: "2026-11-22T11:59:00Z", error: null, eligible: { tag: "v1", version: "1.0.0", firstSeen: "2026-11-22T10:00:00Z" } }]));
  const state = (over: any = {}) => ({ deployed: "v1", state: { written: "2026-11-22T11:55:00Z", deployed: "v1", poll: {}, pins: {}, dispatch: {}, repos, ...over } });
  const pins = Object.fromEntries(SOURCES.map((s) => [s.repo, { version: "1.0.0" } as any]));
  assert.deepEqual([...new Set(assess(state(), null, pins, new Set(), now).map((o) => o.kind))].sort(), ["lag-ok", "watcher-healthy"]);
  const stale = assess(state({ written: "2026-11-22T10:00:00Z" }), null, pins, new Set(), now);
  assert.ok(stale.some((o) => o.kind === "watcher-stalled" && /KV writes are stale/.test(o.detail)));
  assert.ok(!stale.some((o) => o.kind === "update-lag"), "no lag judged from stale state");
  const behind = { ...pins, photocraft: { version: "0.9.0" } as any };
  const lag = assess(state(), null, behind, new Set(), now);
  assert.ok(lag.some((o) => o.kind === "update-lag" && o.repo === "photocraft"));
  assert.ok(!assess(state(), null, behind, new Set(["photocraft\u00001.0.0"]), now).some((o) => o.kind === "update-lag"), "held: has its own issue");
  assert.equal(assess(null, "timeout", pins, new Set(), now)[0].kind, "watcher-stalled");
});

test("health: a timed send's auth error is watcher-auth without watcher-healthy beside it; stuck for 6 hours, watcher-stalled", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const repos = Object.fromEntries(SOURCES.map((s) => [s.repo, { read: "2026-11-22T11:59:00Z", error: null, eligible: { tag: "v1", version: "1.0.0", firstSeen: "2026-11-22T10:00:00Z" } }]));
  const state = (timed: object) => ({ deployed: "v1", state: { written: "2026-11-22T11:55:00Z", deployed: "v1", poll: {}, pins: {}, dispatch: {}, repos, timed } });
  const pins = Object.fromEntries(SOURCES.map((s) => [s.repo, { version: "1.0.0" } as any]));
  const kinds = (timed: object) => [...new Set(assess(state(timed), null, pins, new Set(), now).map((o) => o.kind))].sort();
  const auth = assess(state({ "health.yml": { error: { kind: "auth", message: "HTTP 401", since: "2026-11-22T11:00:00Z" } } }), null, pins, new Set(), now);
  assert.deepEqual([...new Set(auth.map((o) => o.kind))].sort(), ["lag-ok", "watcher-auth"]);
  assert.match(auth.find((o) => o.kind === "watcher-auth")!.detail, /health\.yml: HTTP 401/);
  const stuck = assess(state({ "pages.yml": { error: { kind: "http", message: "HTTP 502", since: "2026-11-22T05:00:00Z" } } }), null, pins, new Set(), now);
  assert.ok(stuck.some((o) => o.kind === "watcher-stalled" && /pages\.yml: failing for more than 6 hours/.test(o.detail)));
  assert.deepEqual(kinds({ "pages.yml": { error: { kind: "rate-limit", message: "429", since: "2026-11-22T11:00:00Z" } } }), ["lag-ok", "watcher-healthy"]);
});

test("NixOS stable in branch CI: only failures the branch introduces count; incomplete counts", () => {
  const r = (failed: string[], complete = true) => ({ set: "b", system: "x", group: "stable" as const, complete, failed });
  assert.deepEqual(regressions(r(["a", "b"]), r(["a"])), ["b"]);
  assert.deepEqual(regressions(r(["a"]), r([], false)), ["a"]);
  assert.deepEqual(regressions(r([], false), null), ["(incomplete)"]);
});

test("health: update-lag only from a repository read fresh and without error; none eligible is lag-ok", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const fresh = { read: "2026-11-22T11:59:00Z", error: null, eligible: { tag: "v1", version: "1.0.0", firstSeen: "2026-11-22T10:00:00Z" } };
  const repos: any = Object.fromEntries(SOURCES.map((s) => [s.repo, fresh]));
  repos.photocraft = { ...fresh, read: "2026-11-22T09:00:00Z" };
  repos.gridcraft = { ...fresh, error: { kind: "http", message: "502", since: "2026-11-22T11:50:00Z" } };
  repos.figcraft = { read: "2026-11-22T11:59:00Z", error: null, eligible: null };
  const body = { deployed: "v1", state: { written: "2026-11-22T11:55:00Z", deployed: "v1", poll: {}, pins: {}, dispatch: {}, repos } };
  const pins = Object.fromEntries(SOURCES.map((s) => [s.repo, { version: "0.9.0" } as any]));
  const o = assess(body, null, pins, new Set(), now);
  const lag = o.filter((x) => x.kind === "update-lag").map((x) => x.repo);
  assert.ok(!lag.includes("photocraft") && !lag.includes("gridcraft"));
  assert.ok(lag.includes("vectorcraft"));
  assert.ok(o.some((x) => x.kind === "lag-ok" && x.repo === "figcraft"));
});

// Contract tests: each file passed between scripts, from its real writer to
// its real readers.
test("contract: held.ts's file, as candidate.ts, update.ts and health.ts read it", async () => {
  const { writeHeld, readHeld } = await import("../scripts/ci/held.ts");
  const gh = new Fake();
  await apply([
    { kind: "test-failed", repo: "photocraft", version: "0.24.0", detail: "x", fingerprint: "fp-hold" },
    { kind: "incomplete-release", repo: "figcraft", version: "0.19.0", detail: "missing" },
  ], gh, new Date("2026-11-22T00:00:00Z"));
  const dir = mkdtempSync(join(tmpdir(), "held-"));
  await writeHeld(join(dir, "held.json"), gh);
  const doc = readHeld(join(dir, "held.json"));
  assert.deepEqual(doc.holds, [{ repo: "photocraft", version: "0.24.0", fingerprint: "fp-hold" }]);
  assert.deepEqual(doc.waiting, [{ repo: "figcraft", version: "0.19.0" }]);
  assert.deepEqual(readHeld(join(dir, "missing.json")), { holds: [], waiting: [], snapshotStuck: [] });
  // candidate.ts make with that very file (the resolve job's order).
  const { make } = await import("../scripts/ci/candidate.ts");
  const { dir: repo } = candidateRepo();
  const old = process.cwd();
  process.chdir(repo);
  process.env.HELD_JSON = join(dir, "held.json");
  try {
    assert.deepEqual(make(join(repo, "out")), []);
  } finally {
    process.chdir(old);
    delete process.env.HELD_JSON;
  }
});

test("contract: test.ts's results through merge-parts.ts into narrow.ts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-"));
  const checks = Object.fromEntries(ALL_CHECKS.map((c) => [c, { out: `/o/${c}`, drv: `/d/${c}` }]));
  const nix: Nix = { evaluate: () => checks, build: () => {}, valid: (p) => !p.endsWith("gridcraft-smoke"), forget: () => {} };
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    for (const part of TEST_PARTS) {
      const { result } = runSuite("candidate", system, part, nix, "tree-c");
      writeFileSync(join(dir, `result-candidate-${system}-${part}.json`), JSON.stringify(result));
    }
  }
  merge(dir, () => {});
  const sets = load(dir);
  assert.equal(outcome(sets, "candidate", new Map([["candidate", "tree-c"]])), "fail");
  assert.deepEqual(sets.get("candidate")!.get("x86_64-linux")!.failed, ["gridcraft-smoke"]);
  assert.equal(outcome(sets, "candidate", new Map([["candidate", "tree-other"]])), "incomplete");
});

test("contract: candidate.ts's inputs.json as narrow.ts and status-reads.ts read it", async () => {
  const { make, load: loadCandidate } = await import("../scripts/ci/candidate.ts");
  const { candidateInputs } = await import("../scripts/ci/status-reads.ts");
  const { dir } = candidateRepo();
  const p = JSON.parse(readFileSync(join(dir, "versions", "gridcraft.json"), "utf8"));
  p.version = "9.9.9";
  writeFileSync(join(dir, "versions", "gridcraft.json"), JSON.stringify(p));
  const old = process.cwd();
  process.chdir(dir);
  try {
    make(join(dir, "out"));
  } finally {
    process.chdir(old);
  }
  const c = loadCandidate(join(dir, "out"));
  assert.deepEqual(c.inputs.map((i) => [i.name, i.to]), [["gridcraft", "9.9.9"]]);
  const read = candidateInputs(readFileSync(join(dir, "out", "inputs.json")), new Set(SOURCES.map((s) => s.repo)));
  assert.deepEqual(read?.map((i: any) => [i.name, i.version]), [["gridcraft", "9.9.9"]]);
});

function stableResults(dir: string, set: string, failed: string[] = [], complete = true, tree = `tree-${set}`) {
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    writeFileSync(join(dir, `stable-${set}-${system}-stable.json`), JSON.stringify({ set, system, group: "stable", tree, complete, failed }));
  }
}
const stableInput = { name: "nixpkgs-stable", files: [], from: "a", to: "b", fingerprint: "b" };

test("nixpkgs-stable is gated on NixOS stable: the candidate narrows unless stable passes; alone it passes only with no new stable failure", () => {
  const dir = results({ ...both("candidate", {}) });
  stableResults(dir, "candidate", ["stable-gridcraft-smoke"]);
  assert.deepEqual(plan([stableInput], load(dir)), ["main"]);
  const ok = results({ ...both("candidate", {}) });
  stableResults(ok, "candidate");
  assert.equal(plan([stableInput], load(ok)), null);
  // Alone (with another input): fails on a stable failure main doesn't have,
  // passes when main has it too.
  const two = [inputs[0], stableInput];
  const d1 = results({ ...both("main", {}), ...both("photocraft", { checked: ["photocraft-smoke"] }), ...both("nixpkgs-stable", {}) });
  stableResults(d1, "main");
  stableResults(d1, "nixpkgs-stable", ["stable-gridcraft-smoke"]);
  const r1 = decide(two, load(d1));
  assert.deepEqual(r1.final, ["photocraft"]);
  assert.ok(r1.observations.some((o) => o.kind === "test-failed" && o.repo === "nixpkgs-stable" && o.fingerprint === "b"));
  const d2 = results({ ...both("main", {}), ...both("photocraft", { checked: ["photocraft-smoke"] }), ...both("nixpkgs-stable", {}) });
  stableResults(d2, "main", ["stable-gridcraft-smoke"]);
  stableResults(d2, "nixpkgs-stable", ["stable-gridcraft-smoke"]);
  assert.deepEqual(decide(two, load(d2)).final.sort(), ["nixpkgs-stable", "photocraft"]);
  // A final with it publishes only with stable passing (beyond main's).
  const f = results({ ...both("final", {}) });
  stableResults(f, "final", ["stable-gridcraft-smoke"]);
  stableResults(f, "main");
  const v = verdict(two, load(f), "final", ["photocraft", "nixpkgs-stable"]);
  assert.equal(v.ok, false);
  assert.ok(v.observations.some((o) => o.kind === "combination-failed" && o.repo === "nixpkgs-stable"));
});

test("a stable snapshot marker takes main's result and needs no narrowing job", () => {
  const marker = { name: "stable-gridcraft", files: [], from: "1", to: "1" };
  assert.deepEqual(plan([marker], load(results(both("candidate", { failed: ["x"] })))), ["main"]);
  assert.deepEqual(plan([inputs[0], marker], load(results(both("candidate", { failed: ["x"] })))), ["main", "photocraft"]);
  const d = decide([inputs[0], marker], load(results({ ...both("main", {}), ...both("photocraft", { checked: ["photocraft-smoke"] }) })));
  assert.deepEqual(d.final.sort(), ["photocraft", "stable-gridcraft"]);
});

test("issues: `available` closes only its own scope's unavailable issue", async () => {
  const gh = new Fake();
  await apply([{ kind: "unavailable", repo: "figcraft", version: "1", detail: "", channel: "stable" } as any], gh, new Date("2026-11-22T00:00:00Z"));
  await apply([{ kind: "available", repo: "figcraft", version: "1", detail: "" }], gh, new Date("2026-11-22T00:01:00Z"));
  assert.equal(gh.issueList[0].state, "open");
  await apply([{ kind: "available", repo: "figcraft", version: "1", detail: "", channel: "stable" } as any], gh, new Date("2026-11-22T00:02:00Z"));
  assert.equal(gh.issueList[0].state, "closed");
});

test("NixOS stable: a result without its tree, or of another tree, doesn't count; a narrowed final needs main's baseline", () => {
  const { stableOutcome } = narrowMod;
  const d = results(both("candidate", {}));
  stableResults(d, "candidate");
  const exp = new Map([["candidate", "tree-candidate"]]);
  assert.equal(stableOutcome(load(d), "candidate", null, exp), "pass");
  assert.equal(stableOutcome(load(d), "candidate", null, new Map([["candidate", "other"]])), "incomplete");
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    writeFileSync(join(d, `stable-candidate-${system}-stable.json`), JSON.stringify({ set: "candidate", system, group: "stable", complete: true, failed: [] }));
  }
  assert.equal(stableOutcome(load(d), "candidate", null, exp), "incomplete", "no tree");
  const f = results(both("final", {}));
  stableResults(f, "final", ["stable-gridcraft-smoke"]);
  const two = [inputs[0], stableInput];
  const v = verdict(two, load(f), "final", ["photocraft", "nixpkgs-stable"]);
  assert.deepEqual([v.ok, v.observations.map((o) => o.kind)], [false, ["update-failed"]], "no baseline: incomplete, nothing held");
  stableResults(f, "main", ["stable-gridcraft-smoke"]);
  assert.equal(verdict(two, load(f), "final", ["photocraft", "nixpkgs-stable"]).ok, true, "main has that failure too");
});

test("a stable-only failure never makes env-broken; main's stable evidence is reported from narrowing", () => {
  const d = results({ ...both("candidate", {}), ...both("main", { failed: ["gridcraft-smoke"] }) });
  stableResults(d, "candidate", ["stable-x"]);
  stableResults(d, "main");
  const r = decide([stableInput], load(d));
  assert.ok(!r.observations.some((o) => o.kind === "env-broken"));
  assert.ok(r.observations.some((o) => o.kind === "test-failed" && o.repo === "nixpkgs-stable" && /stable-x/.test(o.detail)));
  assert.ok(r.observations.some((o) => o.kind === "stable-ok"));
});

test("held.ts's file: a malformed existing file is an error, never an empty hold list", async () => {
  const { readHeld } = await import("../scripts/ci/held.ts");
  const dir = mkdtempSync(join(tmpdir(), "held-bad-"));
  writeFileSync(join(dir, "h.json"), JSON.stringify({ holds: {} }));
  assert.throws(() => readHeld(join(dir, "h.json")), /isn't a held-releases file/);
  writeFileSync(join(dir, "old.json"), JSON.stringify([{ repo: "a", version: "1", fingerprint: "f" }]));
  assert.equal(readHeld(join(dir, "old.json")).holds.length, 1);
});

test("issues: a landed tree's stable evidence supersedes main's from narrowing", async () => {
  const { precedence } = await import("../scripts/ci/issues.ts");
  const gh = new Fake();
  await apply([{ kind: "stable-broken", repo: null, version: null, detail: "old" }], gh, new Date("2026-11-22T00:00:00Z"));
  const run = precedence([
    { kind: "stable-broken", package: null, channel: "main", version: null, detail: "main fails" },
    { kind: "stable-ok", package: null, channel: null, version: null, detail: "" },
    { kind: "published", package: null, channel: null, version: "2026.11.22.1", detail: "" },
  ] as any);
  await apply(run, gh, new Date("2026-11-22T00:05:00Z"));
  assert.equal(gh.issueList[0].state, "closed");
  // Without a landing, main's evidence counts as the run-wide key.
  // Main moved under the run: resolve's stable-current was about the old tree.
  const movedRun = precedence([{ kind: "stable-current", repo: null, version: null, detail: "" }, { kind: "env-ok", repo: null, version: null, detail: "" },
    { kind: "stable-broken", repo: null, channel: "main", version: null, detail: "" }, { kind: "main-moved", repo: null, version: null, detail: "" }] as any);
  assert.deepEqual(movedRun.map((o) => o.kind), ["main-moved"], "all about the old tree");
  // The snapshot resolve probed, replaced by the landing (or main moving).
  const probedOld = [{ kind: "stable-unfetchable", repo: null, version: null, detail: "" }, { kind: "unavailable", repo: "pdfcraft", channel: "stable", version: "0.20.0", detail: "" },
    { kind: "unavailable", repo: "pdfcraft", channel: null, version: "0.21.0", detail: "" }];
  const landed = precedence([...probedOld, { kind: "published", repo: null, version: "r", detail: "", snapshotMoved: true }] as any);
  assert.deepEqual(landed.map((o: any) => [o.kind, o.channel ?? null]), [["unavailable", null], ["published", null]], "main's own pin's evidence stays");
  assert.equal(precedence([...probedOld, { kind: "published", repo: null, version: "r", detail: "" }] as any).length, 4, "no move: it stands");
  // Studio's stable-scope diagnostic read the old snapshot's Studio too.
  assert.ok(!precedence([{ kind: "studio-hosts", repo: "(extraction)", channel: "stable", version: "0.41.0", detail: "" }, { kind: "published", repo: null, version: "r", detail: "", snapshotMoved: true }] as any).some((o) => o.kind === "studio-hosts"));
  const alone = precedence([{ kind: "stable-broken", package: null, channel: "main", version: null, detail: "x" }] as any);
  assert.deepEqual(alone.map((o: any) => [o.kind, o.channel]), [["stable-broken", null]]);
  // An app-only landing whose own stable legs were incomplete: main's
  // verdict still describes the same stable inputs, so it stands.
  const mainOnly = { kind: "stable-broken", package: null, channel: "main", version: null, detail: "main fails" };
  const appOnly = precedence([mainOnly, { kind: "published", package: null, channel: null, version: "r", detail: "", stableChanged: false }] as any);
  assert.deepEqual(appOnly.filter((o) => o.kind === "stable-broken").map((o: any) => o.channel), [null]);
  // A landing that changed NixOS stable's inputs: main's says nothing of it.
  const changed = precedence([mainOnly, { kind: "published", package: null, channel: null, version: "r", detail: "", stableChanged: true }] as any);
  assert.ok(!changed.some((o) => o.kind === "stable-broken"));
});

test("scoping: nixpkgs-stable alone runs only flake-wide checks and those whose derivation differs", () => {
  const s = inScope("nixpkgs-stable", ALL_CHECKS, (c) => c === "gridcraft-files");
  assert.ok(s.includes("aggregate") && s.includes("gridcraft-files"));
  assert.ok(!s.includes("photocraft-smoke") && !s.includes("default-build"));
});

test("status: a pin the watcher saw pulled (a prerelease again) counts as gone", async () => {
  const { upstream } = await import("../scripts/lib/watcher-health.ts");
  const now = new Date("2026-11-22T12:00:00Z");
  const repos: any = Object.fromEntries(SOURCES.map((s) => [s.repo, { read: "2026-11-22T11:59:00Z", error: null, pinned: { tag: "v1.0.0", fingerprint: "x", pulled: false }, eligible: { tag: "v1.0.0", version: "1.0.0", firstSeen: "2026-11-22T10:00:00Z" } }]));
  repos.photocraft = { ...repos.photocraft, pinned: { tag: "v1.0.0", fingerprint: "x", pulled: true } };
  repos.gridcraft = { ...repos.gridcraft, pinned: { tag: "v1.0.0", fingerprint: null } };
  const u = upstream({ deployed: "v", state: { written: "2026-11-22T11:58:00Z", deployed: "v", poll: {}, pins: {}, dispatch: {}, repos } }, now)!;
  assert.deepEqual([...u.pinGone.keys()].sort(), ["gridcraft", "photocraft"]);
  assert.equal(u.pinGone.get("photocraft"), "v1.0.0", "with the tag it was seen for");
});

// Each workflow as parsed YAML (yq, in the unit check's inputs), so a test
// reads its jobs and steps however they're written.
function workflows(): [string, any][] {
  const dir = join(import.meta.dirname, "..", ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.ok(files.length > 0, "workflows found");
  return files.map((f) => {
    let json: string;
    try {
      json = execFileSync("yq", ["-o=json", ".", join(dir, f)], { encoding: "utf8" });
    } catch (e: any) {
      throw new Error(`yq couldn't read ${f} (the unit check has it): ${e.message}`);
    }
    try {
      return [f, JSON.parse(json)];
    } catch (e: any) {
      throw new Error(`${f}: not one YAML document: ${e.message}`);
    }
  });
}

test("workflows: every scheduled workflow is in reconcile's SCHEDULED", () => {
  const scheduled = workflows().filter(([, wf]) => wf?.on?.schedule).map(([f]) => f);
  assert.ok(scheduled.length > 0);
  assert.deepEqual(SCHEDULED.map(([w]) => w).sort(), scheduled.sort());
});
