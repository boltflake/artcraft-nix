// The verifier (scripts/lib/verify.ts), against a throwaway test key in
// tests/fixtures/sign: a certify-only primary with a signing subkey, as
// upstream's, and a stranger's key. Runs gpg; needs no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { checkSignature, manifestEntries, readStatus, verifyRelease, type VerifyDeps } from "../scripts/lib/verify.ts";
import { Failed, Integrity, Transient } from "../scripts/lib/util.ts";
import type { Release, Source } from "../shared/sources.ts";

const dir = join(import.meta.dirname, "fixtures", "sign");
const bytes = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
const trustedFile = JSON.parse(readFileSync(join(dir, "trusted.json"), "utf8"));
const trusted = { primary: trustedFile.primary, signers: [trustedFile.primary, ...trustedFile.subkeys] };
const deps = (files: Record<string, string>, extra: Partial<VerifyDeps> = {}): VerifyDeps => ({
  keyFile: join(dir, "test-key.asc"),
  trusted,
  fetchBytes: async (url) => {
    const name = url.split("/").pop()!;
    return files[name] ? bytes(files[name]) : null;
  },
  ...extra,
});
const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const demo: Source = { repo: "demo", tags: /^v(\d+)\.(\d+)\.(\d+)$/, prefix: "v", packages: { demo: "demo-{version}-linux-{arch}.tar.gz" } };
const release = (manifest: string, sig: string, digests: Record<string, string> = {}): Release => ({
  id: 1, tag: "v1.0.0", draft: false, prerelease: false, publishedAt: "2026-11-22T00:00:00Z", assetsComplete: true,
  assets: [
    { name: "demo-1.0.0-linux-x86_64.tar.gz", id: 11, digest: digests.x86 ?? sha("tar one"), state: "uploaded", size: 7 },
    { name: "demo-1.0.0-linux-aarch64.tar.gz", id: 12, digest: digests.arm ?? sha("tar two"), state: "uploaded", size: 7 },
    { name: "SHA256SUMS.txt", id: 13, digest: sha(bytes(manifest)), state: "uploaded", size: 1 },
    { name: "SHA256SUMS.txt.asc", id: 14, digest: sha(bytes(sig)), state: "uploaded", size: 1 },
  ],
});
const files = (manifest: string, sig: string) => ({ "SHA256SUMS.txt": manifest, "SHA256SUMS.txt.asc": sig });

test("a good signature by the trusted signing subkey verifies, and the pin's assets come from the manifest", async () => {
  const v = await verifyRelease(demo, release("manifest.txt", "manifest.txt.asc"), deps(files("manifest.txt", "manifest.txt.asc")));
  assert.equal(v.packages.demo["x86_64-linux"].url, "https://github.com/storytold/demo/releases/download/v1.0.0/demo-1.0.0-linux-x86_64.tar.gz");
  assert.equal(v.packages.demo["x86_64-linux"].assetId, 11);
  assert.equal(v.packages.demo["aarch64-linux"].hash, `sha256-${createHash("sha256").update("tar two").digest("base64")}`);
  assert.deepEqual(v.manifest, { assetId: 13, digest: sha(bytes("manifest.txt")) });
});

test("the signer is the subkey and the primary is the trusted key", () => {
  const r = checkSignature(bytes("manifest.txt"), bytes("manifest.txt.asc"), deps({}));
  assert.equal(r.primary, trusted.primary);
  assert.equal(r.signer, trustedFile.subkeys[0]);
});

test("a subkey the trusted key doesn't allow is refused", () => {
  assert.throws(() => checkSignature(bytes("manifest.txt"), bytes("manifest.txt.asc"), deps({}, { trusted: { primary: trusted.primary, signers: [trusted.primary] } })),
    (e: any) => e instanceof Integrity && /not one the trusted key allows/.test(e.message));
});

test("a signature over other bytes is bad", () => {
  assert.throws(() => checkSignature(bytes("manifest-dup.txt"), bytes("manifest.txt.asc"), deps({})),
    (e: any) => e instanceof Integrity && /BADSIG/.test(e.message));
});

test("an unknown signer (a key not in the fresh keyring) is refused, and keys are never fetched", async () => {
  await assert.rejects(verifyRelease(demo, release("manifest.txt", "manifest-stranger.txt.asc"), deps(files("manifest.txt", "manifest-stranger.txt.asc"))),
    (e: any) => e instanceof Integrity && /unknown signer/.test(e.message));
});

test("another primary key, even one whose signature is good, is refused", () => {
  assert.throws(() => checkSignature(bytes("manifest.txt"), bytes("manifest.txt.asc"), deps({}, { trusted: { primary: "0".repeat(40), signers: trustedFile.subkeys } })),
    (e: any) => e instanceof Integrity && /not the trusted/.test(e.message));
});

test("a missing manifest entry is an integrity failure", async () => {
  await assert.rejects(verifyRelease(demo, release("manifest-missing.txt", "manifest-missing.txt.asc"), deps(files("manifest-missing.txt", "manifest-missing.txt.asc"))),
    (e: any) => e instanceof Integrity && /has no entries for demo-1.0.0-linux-aarch64/.test(e.message));
});

test("a duplicate manifest entry is an integrity failure", async () => {
  await assert.rejects(verifyRelease(demo, release("manifest-dup.txt", "manifest-dup.txt.asc"), deps(files("manifest-dup.txt", "manifest-dup.txt.asc"))),
    (e: any) => e instanceof Integrity && /has 2 entries/.test(e.message));
});

test("a digest that disagrees with the manifest is an integrity failure", async () => {
  await assert.rejects(verifyRelease(demo, release("manifest.txt", "manifest.txt.asc", { arm: sha("other bytes") }), deps(files("manifest.txt", "manifest.txt.asc"))),
    (e: any) => e instanceof Integrity && /SHA256SUMS.txt says .*GitHub's digest says/.test(e.message));
});

test("a manifest whose bytes don't match GitHub's digest for it is an integrity failure", async () => {
  const r = release("manifest.txt", "manifest.txt.asc");
  r.assets[2].digest = sha("something else");
  await assert.rejects(verifyRelease(demo, r, deps(files("manifest.txt", "manifest.txt.asc"))),
    (e: any) => e instanceof Integrity && /don't match GitHub's digest/.test(e.message));
});

test("a download that doesn't work is a retry, not an integrity failure", async () => {
  await assert.rejects(verifyRelease(demo, release("manifest.txt", "manifest.txt.asc"), deps({})),
    (e: any) => e instanceof Transient && !(e instanceof Integrity));
});

test("an ineligible release isn't verified", async () => {
  const r = release("manifest.txt", "manifest.txt.asc");
  r.assets = r.assets.filter((a) => a.name !== "SHA256SUMS.txt.asc");
  await assert.rejects(verifyRelease(demo, r, deps(files("manifest.txt", "manifest.txt.asc"))),
    (e: any) => e instanceof Failed && !(e instanceof Integrity) && /isn't eligible/.test(e.message));
});

test("manifest parsing: exact names, text and binary mode", () => {
  const hex = "a".repeat(64);
  const text = `${hex}  x.tar.gz\n${hex} *y.tar.gz\n${hex}  x.tar.gz.asc\n`;
  assert.deepEqual(manifestEntries(text, "x.tar.gz"), [hex]);
  assert.deepEqual(manifestEntries(text, "y.tar.gz"), [hex]);
  assert.deepEqual(manifestEntries(text, "z.tar.gz"), []);
});

test("GnuPG's status: two good signatures are not one", () => {
  const line = "[GNUPG:] VALIDSIG A 2026-01-01 0 0 4 0 22 8 00 P";
  const r = readStatus(`[GNUPG:] GOODSIG X n\n${line}\n[GNUPG:] GOODSIG Y n\n${line}\n`);
  assert.match(r.problem ?? "", /expected one good signature/);
});

test("a problem running GnuPG or importing the key is a plain failure, never an integrity hold", () => {
  assert.throws(() => checkSignature(bytes("manifest.txt"), bytes("manifest.txt.asc"), deps({}, { gpg: "/nonexistent/gpg" })),
    (e: any) => e instanceof Failed && !(e instanceof Integrity));
  assert.throws(() => checkSignature(bytes("manifest.txt"), bytes("manifest.txt.asc"), deps({}, { keyFile: join(dir, "missing.asc") })),
    (e: any) => e instanceof Failed && !(e instanceof Integrity) && /couldn't import the trusted key/.test(e.message));
});
