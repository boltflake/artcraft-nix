// The parts' results as the whole suite's, as in t3code-nix: the jobs after
// the tests read one result per set and system. For each set and system run
// in parts (result-SET-SYSTEM-PART.json), writes result-SET-SYSTEM.json:
// complete only when every part's file is there and complete; failed and
// drvs the union. A set run whole (narrowing) is left as it is.
//
//   node merge-parts.ts RESULTS_DIR
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_PARTS } from "../lib/parts.ts";
import type { Result } from "./test.ts";

const PART = new RegExp(`^result-(.+)-(x86_64-linux|aarch64-linux)-(${TEST_PARTS.join("|")})\\.json$`);

export function merge(dir: string, log = console.error): string[] {
  const groups = new Map<string, Map<string, Result | null>>();
  for (const f of readdirSync(dir)) {
    const m = PART.exec(f);
    if (!m) continue;
    const key = `${m[1]}\0${m[2]}`;
    if (!groups.has(key)) groups.set(key, new Map());
    let r: Result | null = null;
    try {
      r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      log(`merge-parts: ${f} doesn't parse; that part counts as missing`);
    }
    groups.get(key)!.set(m[3], r);
  }
  const written: string[] = [];
  for (const [key, parts] of groups) {
    const [set, system] = key.split("\0");
    const missing = TEST_PARTS.filter((p) => !parts.get(p));
    const all = [...parts.values()].filter((r): r is Result => !!r);
    const trees = new Set(all.map((r) => r.tree));
    const merged: Result = {
      set, system, part: null,
      // Every part tested the same tree.
      tree: trees.size === 1 ? [...trees][0] : "",
      complete: missing.length === 0 && all.every((r) => r.complete) && trees.size === 1,
      incomplete: [...new Set(all.flatMap((r) => r.incomplete ?? []))].sort(),
      checked: [...new Set(all.flatMap((r) => r.checked))].sort(),
      failed: [...new Set(all.flatMap((r) => r.failed))].sort(),
      drvs: Object.assign({}, ...all.map((r) => r.drvs)),
    };
    if (missing.length) log(`merge-parts: ${set} ${system} is missing part(s) ${missing.join(", ")}: incomplete`);
    const name = `result-${set}-${system}.json`;
    writeFileSync(join(dir, name), JSON.stringify(merged, null, 2) + "\n");
    written.push(name);
  }
  return written;
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: merge-parts.ts RESULTS_DIR");
    process.exit(2);
  }
  for (const f of merge(dir)) console.log(f);
}
