// New-tracker detection for ArtCraft Studio: an offline check that pulls the
// third-party hosts from the pinned binary and compares them with the
// committed list, shared/studio-hosts.json. Diagnostic, not a test: it never
// holds a release, and its result reaches the issues job even when extraction
// fails.
//
//   node scripts/studio-hosts.ts TARBALL [SCOPE [VERSION]]
//
// SCOPE is default (the default) or stable; VERSION, the pin's version, goes
// into the observations (none when left out).
//
// How: Studio is a Tauri app, which embeds its web
// assets Brotli-compressed in a table of (path, bytes) slices. In the PIE
// binary those slices' pointers are R_X86_64_RELATIVE (aarch64:
// R_AARCH64_RELATIVE) relocations, so the table is found by the relocation
// whose addend is the "/index.html" string, with the data slice right after
// it. The hosts are those index.html names: the page's own loaders, which is
// where Studio loads Google Analytics and Clarity. The CSP isn't stored as
// text (Tauri serialises it at build time), so the committed list keeps the
// CSP's hosts from the source; the JavaScript bundles name some 45 hosts,
// mostly documentation links, and aren't compared.
//
// Prints {observations}, each with the pin's version: `studio-hosts` for
// each host not in the list (key: the host and the scope); `studio-hosts-ok`
// for every host the list records, whether or not this binary still names
// it, so recording a host closes its issue even if Studio has dropped it
// since; and for the extraction itself (`(extraction)`), studio-hosts on
// failure, studio-hosts-ok on success.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { ROOT } from "./lib/util.ts";
import type { Observation } from "./update.ts";

const RELATIVE = new Set([8n /* x86_64 */, 1027n /* aarch64 */]);

/** Every embedded asset whose path matches, decompressed. */
export function embeddedAssets(b: Buffer, want: (path: string) => boolean): Map<string, string> {
  if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2 || b[5] !== 1) throw new Error("not a 64-bit little-endian ELF file");
  const shoff = Number(b.readBigUInt64LE(0x28)), shentsize = b.readUInt16LE(0x3a), shnum = b.readUInt16LE(0x3c);
  const secs = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize;
    return { type: b.readUInt32LE(o + 4), addr: Number(b.readBigUInt64LE(o + 16)), off: Number(b.readBigUInt64LE(o + 24)), size: Number(b.readBigUInt64LE(o + 32)) };
  });
  const toOff = (a: number) => {
    const s = secs.find((x) => x.addr && x.type !== 8 /* NOBITS */ && a >= x.addr && a < x.addr + x.size);
    return s ? a - s.addr + s.off : -1;
  };
  const rel = new Map<number, number>();
  for (const s of secs.filter((x) => x.type === 4 /* RELA */)) {
    for (let o = s.off; o + 24 <= s.off + s.size; o += 24) {
      if (RELATIVE.has(b.readBigUInt64LE(o + 8) & 0xffffffffn)) rel.set(Number(b.readBigUInt64LE(o)), Number(b.readBigInt64LE(o + 16)));
    }
  }
  const out = new Map<string, string>();
  for (const [slot, pathAddr] of rel) {
    const o = toOff(slot);
    if (o < 0 || o + 32 > b.length) continue;
    const len = Number(b.readBigUInt64LE(o + 8));
    if (len < 2 || len > 512) continue;
    const p = toOff(pathAddr);
    if (p < 0 || b[p] !== 0x2f) continue;
    const path = b.subarray(p, p + len).toString("latin1");
    if (!/^\/[\x21-\x7e]+$/.test(path) || !want(path)) continue;
    const data = rel.get(slot + 16);
    const dlen = Number(b.readBigUInt64LE(o + 24));
    const d = data === undefined ? -1 : toOff(data);
    if (d < 0 || dlen <= 0 || d + dlen > b.length) continue;
    try { out.set(path, brotliDecompressSync(b.subarray(d, d + dlen)).toString("utf8")); } catch { /* not this slice */ }
  }
  return out;
}

export const hostsIn = (text: string) =>
  [...new Set([...text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1].toLowerCase()))].sort();

/** Whether the committed list covers a host (a wildcard entry covers its
 * subdomains). */
export function listed(host: string, list: { host: string }[]): boolean {
  return list.some((e) => e.host === host || (e.host.startsWith("*.") && host.endsWith(e.host.slice(1))));
}

export function compare(found: string[] | null, scope: string, list: { host: string }[], error = "", version: string | null = null): Observation[] {
  const o = (kind: string, host: string, detail = ""): Observation => ({ kind, repo: host, version, detail, channel: scope });
  // Recorded hosts close their findings on the list alone.
  const ok = list.map((e) => o("studio-hosts-ok", e.host));
  if (!found) return [o("studio-hosts", "(extraction)", `couldn't extract Studio's hosts from the ${scope} pin${version ? ` (${version})` : ""}: ${error}`), ...ok];
  return [
    o("studio-hosts-ok", "(extraction)"),
    ...ok,
    ...found.filter((h) => !listed(h, list)).map((h) =>
      o("studio-hosts", h, `Studio's page (index.html, ${scope} pin${version ? `, ${version}` : ""}) names ${h}, which shared/studio-hosts.json doesn't list. A finding to review, not proof of use: add it as \`disclosed\` after looking; marking it \`blocked\` changes what the option blocks.`)),
  ];
}

if (import.meta.main) {
  const [tarball, scope = "default", version = null] = process.argv.slice(2);
  const list = JSON.parse(readFileSync(join(ROOT, "shared", "studio-hosts.json"), "utf8")).hosts;
  let found: string[] | null = null, error = "";
  try {
    const bin = execFileSync("tar", ["-xzf", tarball, "--wildcards", "*/bin/artcraft", "-O"], { maxBuffer: 512 << 20 });
    const html = embeddedAssets(bin, (p) => p === "/index.html").get("/index.html");
    if (!html || !/<html/i.test(html)) throw new Error("no index.html among the embedded assets");
    found = hostsIn(html);
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  console.log(JSON.stringify({ observations: compare(found, scope, list, error, version) }, null, 2));
}
