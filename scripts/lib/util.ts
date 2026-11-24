// Small helpers shared by the scripts. Node's standard library only: no npm
// dependencies to keep up to date.
import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEMS, type System } from "../../shared/sources.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERSIONS = join(ROOT, "versions");
export const KEYS = join(ROOT, "keys");
export { SYSTEMS };
export const UA = "artcraft-nix (https://github.com/boltflake/artcraft-nix)";

/** One repository's failure; callers catch it so the others carry on. */
export class Failed extends Error {}
/** A failure that says something about the release's files: a bad signature,
 * a missing manifest entry, a digest mismatch. Holds the release. */
export class Integrity extends Failed {}
/** A network error or an unexpected status: retried by the next run, never
 * an integrity failure. */
export class Transient extends Failed {}

export function fail(message: string): never {
  throw new Failed(message);
}

export interface Asset {
  url: string;
  /** SRI, for fetchurl. */
  hash: string;
  assetId: number;
  /** GitHub's "sha256:<hex>". */
  digest: string;
}

/** versions/<repo>.json: one repository release, every package from it. */
export interface Pin {
  repo: string;
  version: string;
  tag: string;
  releaseId: number;
  /** The signed manifest and its signature, as verified. */
  manifest: { assetId: number; digest: string };
  signature: { assetId: number; digest: string };
  /** Per package and system. */
  packages: Record<string, Record<string, Asset>>;
  /** Studio's licence files, from the tag's commit. */
  licenses?: Record<string, { url: string; hash: string }>;
  released?: { at: string; kind: "published" | "seen" };
  /** A pinned asset confirmed gone (see "Unavailable packages"). */
  unavailable?: { since: string; issue: number | null; packages: string[] };
}

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export const sri = (hex: string) => `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
export const hexOfDigest = (digest: string) => {
  const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!m) fail(`not a sha256 digest: ${JSON.stringify(digest)}`);
  return m[1];
};

/** Write JSON atomically, with a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
export const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
export const currentPin = (repo: string, dir = VERSIONS): Pin | null => {
  const p = join(dir, `${repo}.json`);
  return existsSync(p) ? readJson(p) : null;
};

/** Hosts files may come from: GitHub, its API and its asset hosts. */
const ALLOWED = new Set([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
/** The largest file read at resolve time (manifests, signatures, licences). */
export const MAX_BYTES = 1 << 20;

function headers(url: URL): Record<string, string> {
  const h: Record<string, string> = { "user-agent": UA };
  const token = process.env.GITHUB_TOKEN;
  if (token && url.hostname === "api.github.com") h.authorization = `Bearer ${token}`;
  if (url.hostname === "api.github.com") {
    h.accept = "application/vnd.github+json";
    h["x-github-api-version"] = "2022-11-28";
  }
  return h;
}

/** GET with every redirect checked against the allowed hosts, a timeout and
 * a size bound. A 404 is `null` when `missingOk`. Network errors and
 * unexpected statuses are Transient. */
export async function get(raw: string, { missingOk = false, max = MAX_BYTES, timeoutMs = 30_000 } = {}): Promise<Uint8Array | null> {
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:" || !ALLOWED.has(url.hostname)) fail(`refusing to download from ${url.origin}`);
    let res: Response;
    try {
      res = await fetch(url, { headers: headers(url), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new Transient(`${url.origin}${url.pathname}: ${e?.message ?? e}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Transient(`${url.pathname}: redirect without a location`);
      url = new URL(next, url);
      continue;
    }
    if (res.status === 404 && missingOk) return null;
    if (!res.ok) throw new Transient(`${url.origin}${url.pathname}: HTTP ${res.status}`);
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > max) fail(`${url.pathname}: ${length} bytes, more than ${max}`);
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e: any) {
        throw new Transient(`${url.origin}${url.pathname}: the download broke off: ${e?.message ?? e}`);
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        fail(`${url.pathname}: more than ${max} bytes`);
      }
      parts.push(value);
    }
    return Buffer.concat(parts);
  }
  throw new Transient(`${raw}: too many redirects`);
}
export async function getJson(url: string, opts: { missingOk?: boolean } = {}): Promise<any> {
  const bytes = await get(url, { ...opts, max: 16 << 20 });
  if (bytes === null) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Transient(`${url}: not JSON`);
  }
}

/** Every page of a GitHub list endpoint, up to `maxPages`; `complete` is
 * false when there were more. */
export async function getPages(url: string, maxPages = 1): Promise<{ items: any[]; complete: boolean }> {
  const items: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const got = await getJson(`${url}${sep}page=${page}`);
    if (!Array.isArray(got)) throw new Transient(`${url}: not a list`);
    items.push(...got);
    if (got.length === 0 || !/per_page=(\d+)/.test(url) || got.length < Number(/per_page=(\d+)/.exec(url)![1])) {
      return { items, complete: true };
    }
  }
  return { items, complete: false };
}

/** The system's tarball for a package, or a clear error. */
export const assetFor = (pin: Pin, pkg: string, system: System): Asset =>
  pin.packages[pkg]?.[system] ?? fail(`${pin.repo} ${pin.version} has no ${pkg} for ${system}`);

/** Run promises together, but report the first failure in list order. */
export async function allInOrder<T>(ps: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(ps);
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

/** Run a program; its trimmed stdout, or an exception with status, stdout
 * and stderr. */
export function run(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, ...opts });
  return out == null ? "" : String(out).trim();
}
export function tryRun(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): { status: number; stdout: string; stderr: string; cut?: boolean } {
  try {
    return { status: 0, stdout: run(cmd, args, opts), stderr: "" };
  } catch (e: any) {
    // Any exception is a failure: a spawn error can carry status 0.
    const status = typeof e.status === "number" && e.status !== 0 ? e.status : 1;
    const stderr = [String(e.stderr ?? "").trim(), e.code || e.signal ? `(${e.code ?? e.signal}: ${e.message})` : ""].filter(Boolean).join("\n");
    // `cut`: the command didn't run to its own end (a timeout, a signal, or
    // it never started), so what it left undone says nothing.
    const cut = !!(e.code || e.signal) || typeof e.status !== "number";
    return { status, stdout: String(e.stdout ?? "").trim(), stderr, ...(cut ? { cut } : {}) };
  }
}
export const git = (...args: string[]) => run("git", args);

/** The nixpkgs revision a flake.lock (as text, or parsed) locks, or null. */
export function nixpkgsRev(lock: string | object | null): string | null {
  try {
    const doc: any = typeof lock === "string" ? JSON.parse(lock) : lock;
    const rev = doc?.nodes?.nixpkgs?.locked?.rev;
    return typeof rev === "string" ? rev : null;
  } catch {
    return null;
  }
}

/** Waits, replaceable in tests. */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), backoffMs: 1000 };

/** Whether a download exists, by HEAD with every redirect checked against
 * the allowed hosts: false only on a 404; other statuses and network errors
 * are Transient. */
export async function exists(raw: string, timeoutMs = 30_000): Promise<boolean> {
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:" || !ALLOWED.has(url.hostname)) fail(`refusing to probe ${url.origin}`);
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", headers: headers(url), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new Transient(`${url.origin}${url.pathname}: ${e?.message ?? e}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Transient(`${url.pathname}: redirect without a location`);
      url = new URL(next, url);
      continue;
    }
    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new Transient(`${url.origin}${url.pathname}: HTTP ${res.status}`);
  }
  throw new Transient(`${raw}: too many redirects`);
}
