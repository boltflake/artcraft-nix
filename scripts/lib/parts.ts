// Branch CI and the update runs' test and final jobs run the default suite in
// parts, each on a runner of its own, as in t3code-nix (scripts/lib/parts.ts).
// Here the apps are spread over the app parts by size, with an app's checks
// kept together (each part downloads only its share of the tarballs), Studio
// in a part of its own, `default-build` in one of its own (it fetches every
// tarball in `default`), and the flake-wide checks and the companions in
// `flake`. The exact layout is to be set from the first runs' timings.
//
// NixOS stable (stable.ts) runs as one part per group (stable, stable-next).
import { SOURCES } from "../../shared/sources.ts";

export const TEST_PARTS = ["apps1", "apps2", "apps3", "studio", "flake", "default-build"] as const;
export type TestPart = (typeof TEST_PARTS)[number];
const APP_PARTS: TestPart[] = ["apps1", "apps2", "apps3"];

/** Each Craft App's x86_64 tarball, in MB (measured 2026-11-22); the
 * aarch64 ones are within a few percent. A new app weighs the median. */
export const SIZE_MB: Record<string, number> = {
  photocraft: 139, vectorcraft: 157, filmcraft: 112, lightcraft: 122, pdfcraft: 121, effectcraft: 81, anicraft: 19,
  designcraft: 125, figcraft: 102, texturecraft: 43, materialcraft: 22, soundcraft: 21, wordcraft: 118, deckcraft: 104,
  cadcraft: 75, gridcraft: 53, "craft-anything": 70,
};

/** The app parts, filled greedily by size (largest first, into the lightest
 * part), so each downloads about the same. Deterministic. */
export function appParts(apps = SOURCES.filter((s) => s.repo !== "artcraft").map((s) => s.repo)): Map<string, TestPart> {
  const known = Object.values(SIZE_MB).sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)];
  const weight = (a: string) => SIZE_MB[a] ?? median;
  const load = new Map(APP_PARTS.map((p) => [p, 0]));
  const out = new Map<string, TestPart>();
  for (const a of [...apps].sort((x, y) => weight(y) - weight(x) || x.localeCompare(y))) {
    const part = APP_PARTS.reduce((best, p) => (load.get(p)! < load.get(best)! ? p : best));
    out.set(a, part);
    load.set(part, load.get(part)! + weight(a));
  }
  return out;
}

/** The app a check belongs to ("<app>-<check>"), or null for a flake-wide
 * check. The longest matching name wins (pdfcraft-cli before pdfcraft). */
export function packageOf(check: string, packages: string[]): string | null {
  let best: string | null = null;
  for (const p of packages) if (check.startsWith(`${p}-`) && (!best || p.length > best.length)) best = p;
  return best;
}

export function testPart(check: string, packages: string[], parts = appParts()): TestPart {
  if (check === "default-build") return "default-build";
  const p = packageOf(check, packages);
  if (p === "artcraft-studio") return "studio";
  if (p && parts.has(p)) return parts.get(p)!;
  return "flake";
}

/** The part given on the command line (`--part=NAME`), checked; undefined
 * when none is given (the whole suite). */
export function partArg<P extends string>(argv: string[], parts: readonly P[]): P | undefined {
  const args = argv.filter((a) => a === "--part" || a.startsWith("--part="));
  if (args.length === 0) return undefined;
  if (args.length > 1) throw new Error("--part given more than once");
  const part = args[0].slice("--part=".length) as P;
  if (!parts.includes(part)) throw new Error(`--part must be one of ${parts.join(", ")}, not ${JSON.stringify(part)}`);
  return part;
}
