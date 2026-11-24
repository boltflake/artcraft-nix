// The `pins` check: every pin matches shared/sources.ts, and every URL names
// its version.
//
//   node scripts/check-pins.ts DIR...
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { downloadUrl, requiredAssets, sourceOf, SOURCES, versionOf } from "../shared/sources.ts";

export function problems(pin: any, file: string): string[] {
  const out: string[] = [];
  let source;
  try { source = sourceOf(pin.repo); } catch { return [`${file}: unknown repository ${JSON.stringify(pin.repo)}`]; }
  if (`${pin.repo}.json` !== file) out.push(`${file}: names repository ${pin.repo}`);
  const version = versionOf(source, pin.tag ?? "");
  if (!version) out.push(`${file}: tag ${pin.tag} doesn't match ${source.tags}`);
  else if (version !== pin.version) out.push(`${file}: version ${pin.version}, but its tag says ${version}`);
  for (const k of ["releaseId"]) if (!Number.isInteger(pin[k])) out.push(`${file}: no ${k}`);
  for (const k of ["manifest", "signature"]) {
    if (!Number.isInteger(pin[k]?.assetId) || !/^sha256:[0-9a-f]{64}$/.test(pin[k]?.digest ?? "")) out.push(`${file}: bad ${k}`);
  }
  const wanted = version ? requiredAssets(source, version) : [];
  const pkgs = Object.keys(pin.packages ?? {}).sort();
  const expected = Object.keys(source.packages).sort();
  if (pkgs.join() !== expected.join()) out.push(`${file}: packages ${pkgs.join(", ")}, expected ${expected.join(", ")}`);
  for (const { pkg, system, name } of wanted) {
    const a = pin.packages?.[pkg]?.[system];
    if (!a) { out.push(`${file}: no ${pkg} for ${system}`); continue; }
    if (a.url !== downloadUrl(source.repo, pin.tag, name)) out.push(`${file}: ${pkg} ${system}: URL ${a.url} isn't ${name} of ${pin.tag}`);
    if (!a.url.includes(pin.version)) out.push(`${file}: ${pkg} ${system}: the URL doesn't name the version`);
    const hex = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? "")?.[1];
    if (!hex || a.hash !== `sha256-${Buffer.from(hex, "hex").toString("base64")}`) out.push(`${file}: ${pkg} ${system}: hash and digest disagree`);
    if (!Number.isInteger(a.assetId)) out.push(`${file}: ${pkg} ${system}: no asset ID`);
  }
  if (pin.unavailable) {
    const u = pin.unavailable;
    if (typeof u.since !== "string" || !Array.isArray(u.packages) || u.packages.some((p: string) => !expected.includes(p))) out.push(`${file}: bad unavailable marker`);
  }
  return out;
}

if (import.meta.main) {
  let bad = 0;
  for (const dir of process.argv.slice(2)) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "nixpkgs-stable.json");
    const names = new Set(files.map((f) => f.slice(0, -5)));
    if (!dir.endsWith("stable")) for (const s of SOURCES) if (!names.has(s.repo)) { bad++; console.log(`${dir}: no pin for ${s.repo}`); }
    for (const f of files) {
      for (const p of problems(JSON.parse(readFileSync(join(dir, f), "utf8")), f)) { bad++; console.log(`${dir}/${p}`); }
    }
    console.log(`${dir}: ${files.length} pins checked`);
  }
  process.exit(bad ? 1 : 0);
}
