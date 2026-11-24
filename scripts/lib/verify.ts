// The verifier: a release counts only when its SHA256SUMS.txt is signed by
// the committed key (keys/), and every required tarball has exactly one entry
// there that equals GitHub's digest for it. fetchurl then checks the bytes
// against that hash. Used by pin.ts and the updater alike.
//
// Only the manifest and its signature are downloaded, never the tarballs, so
// the per-asset .asc files aren't used. Keys are never fetched: the keyring
// is fresh for every check and holds only keys/release-signing-key.asc.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadUrl, ineligible, MANIFEST, requiredAssets, SIGNATURE, versionOf, type Release, type Source, type System,
} from "../../shared/sources.ts";
import { Failed, get, hexOfDigest, Integrity, KEYS, readJson, sha256Hex, sri, Transient, type Asset } from "./util.ts";

export interface TrustedKey {
  /** The primary key's full fingerprint. */
  primary: string;
  /** Fingerprints allowed to make the signature (the primary or its signing
   * subkeys). */
  signers: string[];
}
export const trustedKey = (dir = KEYS): TrustedKey => {
  const t = readJson(join(dir, "trusted.json"));
  return { primary: t.primary, signers: [t.primary, ...t.subkeys] };
};

export interface Verified {
  manifest: { assetId: number; digest: string };
  signature: { assetId: number; digest: string };
  /** Per package and system, ready for a pin. */
  packages: Record<string, Record<string, Asset>>;
}

export interface VerifyDeps {
  /** Downloads a file (default: util.get, which throws Transient on network
   * errors). */
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;
  /** The armoured public key file. */
  keyFile?: string;
  trusted?: TrustedKey;
  /** The gpg program (default: $GPG or gpg on PATH). */
  gpg?: string;
}

/** What GnuPG's machine-readable status says about one detached signature. */
export function readStatus(status: string): { signer: string | null; primary: string | null; problem: string | null } {
  const lines = status.split("\n").filter((l) => l.startsWith("[GNUPG:] "));
  const words = (l: string) => l.slice(9).trim().split(/\s+/);
  const bad = lines.map(words).find((w) => ["BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG", "NO_PUBKEY"].includes(w[0]));
  if (bad) return { signer: null, primary: null, problem: bad[0] === "NO_PUBKEY" || bad[0] === "ERRSIG" ? "an unknown signer" : `GnuPG reports ${bad[0]}` };
  const valid = lines.map(words).filter((w) => w[0] === "VALIDSIG");
  const good = lines.map(words).filter((w) => w[0] === "GOODSIG");
  if (valid.length !== 1 || good.length !== 1) return { signer: null, primary: null, problem: `expected one good signature, found ${valid.length}` };
  const v = valid[0];
  // VALIDSIG <fpr> <date> <ts> <expire> <version> <reserved> <pk-algo> <hash-algo> <class> <primary-fpr>
  return { signer: v[1] ?? null, primary: v[10] ?? v[1] ?? null, problem: null };
}

/** Check a detached signature over exact bytes, in a fresh keyring holding
 * only the committed key. Throws Integrity unless it's good and the signer is
 * trusted. */
export function checkSignature(data: Uint8Array, sig: Uint8Array, deps: VerifyDeps = {}): { signer: string; primary: string } {
  const gpg = deps.gpg ?? process.env.GPG ?? "gpg";
  const keyFile = deps.keyFile ?? join(KEYS, "release-signing-key.asc");
  const trusted = deps.trusted ?? trustedKey();
  const home = mkdtempSync(join(tmpdir(), "artcraft-verify-"));
  try {
    // A problem running GnuPG or reading the committed key is ours, never
    // the release's: it fails the run (Failed), it doesn't hold anything.
    const exec = (args: string[]) => {
      try {
        return { status: 0, stdout: execFileSync(gpg, ["--batch", "--no-tty", "--homedir", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e: any) {
        if (e?.code === "ENOENT" || typeof e?.status !== "number") throw new Failed(`couldn't run ${gpg}: ${e?.message ?? e}`);
        return { status: e.status as number, stdout: String(e?.stdout ?? "") };
      }
    };
    const imported = exec(["--status-fd", "1", "--import", keyFile]);
    if (imported.status !== 0 || !/^\[GNUPG:\] IMPORT_OK /m.test(imported.stdout)) {
      throw new Failed(`couldn't import the trusted key ${keyFile} (gpg exited ${imported.status})`);
    }
    const run = (args: string[]) => exec(args).stdout;
    writeFileSync(join(home, "data"), data);
    writeFileSync(join(home, "data.asc"), sig);
    const status = run(["--status-fd", "1", "--verify", join(home, "data.asc"), join(home, "data")]);
    const { signer, primary, problem } = readStatus(status);
    if (problem || !signer || !primary) throw new Integrity(`the signature isn't good: ${problem ?? "no signer"}`);
    if (primary !== trusted.primary) throw new Integrity(`signed by key ${primary}, not the trusted ${trusted.primary}`);
    if (!trusted.signers.includes(signer)) throw new Integrity(`signed by subkey ${signer}, not one the trusted key allows`);
    return { signer, primary };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A manifest's entries for one file name (sha256sum's format, text or
 * binary mode). */
export function manifestEntries(text: string, name: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m && m[2] === name) out.push(m[1].toLowerCase());
  }
  return out;
}

/** Verify one release for its pin. Integrity for anything wrong with the
 * release's files, Transient for a download that didn't work, Failed for a
 * release that isn't eligible. */
export async function verifyRelease(source: Source, release: Release, deps: VerifyDeps = {}): Promise<Verified> {
  const version = versionOf(source, release.tag);
  const why = ineligible(source, release);
  if (!version || why) throw new Failed(`${source.repo} ${release.tag} isn't eligible: ${why}`);
  const byName = new Map(release.assets.map((a) => [a.name, a]));
  const fetchBytes = deps.fetchBytes ?? ((u: string) => get(u));
  const download = async (name: string) => {
    const a = byName.get(name)!;
    const bytes = await fetchBytes(downloadUrl(source.repo, release.tag, name));
    if (!bytes) throw new Transient(`${source.repo} ${release.tag}: ${name} didn't download`);
    if (`sha256:${sha256Hex(bytes)}` !== a.digest) throw new Integrity(`${name}: its bytes don't match GitHub's digest ${a.digest}`);
    return bytes;
  };
  const [manifestBytes, sigBytes] = [await download(MANIFEST), await download(SIGNATURE)];
  try {
    checkSignature(manifestBytes, sigBytes, deps);
  } catch (e: any) {
    if (e instanceof Integrity) throw new Integrity(`${source.repo} ${release.tag}: ${SIGNATURE}: ${e.message}`);
    throw e;
  }
  const text = Buffer.from(manifestBytes).toString("utf8");
  const packages: Record<string, Record<string, Asset>> = {};
  for (const { pkg, system, name } of requiredAssets(source, version)) {
    const a = byName.get(name)!;
    const entries = manifestEntries(text, name);
    if (entries.length !== 1) throw new Integrity(`${source.repo} ${release.tag}: ${MANIFEST} has ${entries.length || "no"} entries for ${name}`);
    const hex = hexOfDigest(a.digest!);
    if (entries[0] !== hex) throw new Integrity(`${source.repo} ${release.tag}: ${name}: ${MANIFEST} says ${entries[0]}, GitHub's digest says ${hex}`);
    (packages[pkg] ??= {})[system as System] = { url: downloadUrl(source.repo, release.tag, name), hash: sri(hex), assetId: Number(a.id), digest: a.digest! };
  }
  const ref = (n: string) => ({ assetId: Number(byName.get(n)!.id), digest: byName.get(n)!.digest! });
  return { manifest: ref(MANIFEST), signature: ref(SIGNATURE), packages };
}

/** For tests: read a file as bytes. */
export const bytesOf = (path: string) => new Uint8Array(readFileSync(path));
