// The resolver (scripts/update.ts) with GitHub and the verifier stubbed:
// pin writing, held releases and retries, integrity, same-tag changes,
// downgrades, incomplete releases, unavailable packages, and the nixpkgs
// bump's due rule and budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpBudget, bumpDue, DAY_MS, keyId, pinFingerprint, Report, resolveRepo, retryRepos, RELEASE_RUN_BUMP_MS, type Io,
} from "../scripts/update.ts";
import { BUMP_BUDGET_MS } from "../scripts/lib/nixcache.ts";
import { fingerprint, requiredNames, sourceOf, type Release } from "../shared/sources.ts";
import { Integrity, Transient, type Pin } from "../scripts/lib/util.ts";

const src = sourceOf("pdfcraft");
const NOW = new Date("2026-11-22T12:00:00Z");
let nextId = 1000;
/** A release of pdfcraft with every required asset; `salt` changes bytes. */
function rel(version: string, opts: { publishedAt?: string; missing?: string[]; draft?: boolean; prerelease?: boolean; salt?: string; ids?: number } = {}): Release {
  const base = opts.ids ?? nextId;
  nextId += 10;
  return {
    id: base, tag: `v${version}`, draft: !!opts.draft, prerelease: !!opts.prerelease, assetsComplete: true,
    publishedAt: opts.publishedAt ?? "2026-11-22T10:00:00Z",
    assets: requiredNames(src, version).filter((n) => !opts.missing?.includes(n)).map((n, i) => ({
      name: n, id: base + i, digest: `sha256:${(opts.salt ?? "0").repeat(64).slice(0, 63)}${i.toString(16)}`, state: "uploaded", size: 1,
    })),
  };
}
/** The pin the stub verifier builds from a release. */
function pinOf(r: Release, extra: Partial<Pin> = {}): Pin {
  const v = r.tag.slice(1);
  const by = new Map(r.assets.map((a) => [a.name, a]));
  const asset = (n: string) => ({ url: `https://github.com/storytold/pdfcraft/releases/download/${r.tag}/${n}`, hash: "sha256-x", assetId: Number(by.get(n)!.id), digest: by.get(n)!.digest! });
  return {
    repo: "pdfcraft", version: v, tag: r.tag, releaseId: Number(r.id),
    manifest: { assetId: Number(by.get("SHA256SUMS.txt")!.id), digest: by.get("SHA256SUMS.txt")!.digest! },
    signature: { assetId: Number(by.get("SHA256SUMS.txt.asc")!.id), digest: by.get("SHA256SUMS.txt.asc")!.digest! },
    packages: {
      pdfcraft: { "x86_64-linux": asset(`pdfcraft-${v}-linux-x86_64.tar.gz`), "aarch64-linux": asset(`pdfcraft-${v}-linux-aarch64.tar.gz`) },
      "pdfcraft-cli": { "x86_64-linux": asset(`pdfcraft-cli-${v}-linux-x86_64.tar.gz`), "aarch64-linux": asset(`pdfcraft-cli-${v}-linux-aarch64.tar.gz`) },
    },
    ...extra,
  };
}
interface Fake { list: Release[]; byTag?: Record<string, Release | null>; gone?: Set<number>; replaced?: Set<number>; verify?: (r: Release) => Pin; readError?: string; truncated?: boolean }
const io = (f: Fake): Io => ({
  releases: async () => { if (f.readError) throw new Transient(f.readError); return { items: f.list, complete: !f.truncated }; },
  releaseByTag: async (_s, tag) => (f.byTag && tag in f.byTag ? f.byTag[tag] : f.list.find((r) => r.tag === tag) ?? null),
  asset: async (_s, id) => (f.gone?.has(id) ? "gone" : f.replaced?.has(id) ? "replaced" : "present"),
  buildPin: async (_s, r) => (f.verify ? f.verify(r) : pinOf(r)),
});
const run = async (f: Fake, old: Pin | null, held = new Set<string>(), retry = false, waits: string[] = []) => {
  const report = new Report(NOW);
  await resolveRepo(report, src, held, retry, NOW, io(f), old, waits);
  return report;
};
const kinds = (r: Report) => r.observations.map((o) => o.kind).sort();

test("a new eligible release is pinned, with every package from it", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0");
  const r = await run({ list: [b, a] }, pinOf(a));
  assert.deepEqual(r.changed, [{ repo: "pdfcraft", from: "0.21.1", to: "0.22.0", why: "a new release" }]);
  assert.deepEqual(Object.keys(r.pins.get("pdfcraft")!.packages), ["pdfcraft", "pdfcraft-cli"]);
  // Read and verified: probed, whatever the tests say later.
  assert.ok(r.observations.some((o) => o.kind === "probed" && o.repo === "pdfcraft"));
});

test("unavailable: an unmarked pin whose file was replaced at its URL isn't available", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a);
  const cliId = pin.packages["pdfcraft-cli"]["x86_64-linux"].assetId;
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== cliId) };
  const r = await run({ list: [listed], replaced: new Set([cliId]) }, pin);
  assert.ok(!r.observations.some((o) => o.kind === "available" || o.kind === "unavailable"));
});

test("the pin that is the highest eligible release passes, and nothing changes", async () => {
  const a = rel("0.21.1");
  const r = await run({ list: [a] }, pinOf(a));
  assert.deepEqual(r.changed, []);
  assert.deepEqual(kinds(r), ["available", "pass", "probed"]);
});

test("a held release (by fingerprint) is skipped, and retried only in a run with nothing new", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0");
  const held = new Set([`pdfcraft\0${fingerprint(src, b)}`]);
  const first = await run({ list: [b, a] }, pinOf(a), held);
  assert.deepEqual(first.changed, []);
  assert.ok(first.observations.some((o) => o.kind === "held" && o.version === "0.22.0" && o.fingerprint === fingerprint(src, b)));
  assert.deepEqual([...retryRepos(first, false)], ["pdfcraft"]);
  assert.deepEqual([...retryRepos(first, true)], [], "a nixpkgs bump is something new");
  const retried = await run({ list: [b, a] }, pinOf(a), held, true);
  assert.equal(retried.changed[0]?.to, "0.22.0");
});

test("a held release whose assets change is a new input (a new fingerprint)", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0", { ids: 5000 });
  const held = new Set([`pdfcraft\0${fingerprint(src, b)}`]);
  const repaired = rel("0.22.0", { ids: 6000 });
  const r = await run({ list: [repaired, a] }, pinOf(a), held);
  assert.equal(r.changed[0]?.to, "0.22.0");
});

test("a release that doesn't verify is held as integrity, keyed by its fingerprint and the trusted key, and the pin stays", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0");
  const r = await run({ list: [b, a], verify: () => { throw new Integrity("signed by key X, not the trusted Y"); } }, pinOf(a));
  assert.ok(r.observations.some((o) => o.kind === "probed"), "the downloads worked: an earlier resolve-failed closes");
  assert.deepEqual(r.changed, []);
  const o = r.observations.find((x) => x.kind === "integrity")!;
  assert.equal(o.fingerprint, `${fingerprint(src, b)}|key:${keyId()}`);
  assert.match(o.detail, /not the trusted/);
  // Held while the key is the same; after a key change it's verified afresh.
  const again = await run({ list: [b, a] }, pinOf(a), new Set([`pdfcraft\0${o.fingerprint}`]));
  assert.ok(again.observations.some((x) => x.kind === "held"));
  const rotated = await run({ list: [b, a] }, pinOf(a), new Set([`pdfcraft\0${fingerprint(src, b)}|key:OLDKEY`]));
  assert.equal(rotated.changed[0]?.to, "0.22.0");
});

test("a transient download error is a retry (resolve-failed), never integrity", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0");
  const r = await run({ list: [b, a], verify: () => { throw new Transient("HTTP 502"); } }, pinOf(a));
  assert.deepEqual(r.changed, []);
  assert.ok(r.observations.some((o) => o.kind === "resolve-failed"));
  assert.ok(!r.observations.some((o) => o.kind === "integrity"));
});

test("a same-tag change that verifies is re-pinned, with an integrity record", async () => {
  const a = rel("0.21.1", { ids: 7000 });
  const reuploaded = rel("0.21.1", { ids: 7100, salt: "1" });
  const r = await run({ list: [reuploaded] }, pinOf(a));
  assert.equal(r.changed[0]?.why, "the same release's files changed and verify (re-pinned)");
  const record = r.observations.find((o) => o.kind === "integrity")!;
  assert.match(record.detail, /for the record/);
  assert.equal(record.fingerprint, undefined, "the record holds nothing");
});

test("a same-tag change that doesn't verify is held, and the pin stays", async () => {
  const a = rel("0.21.1", { ids: 7200 });
  const reuploaded = rel("0.21.1", { ids: 7300 });
  const r = await run({ list: [reuploaded], verify: () => { throw new Integrity("SHA256SUMS.txt has no entries"); } }, pinOf(a));
  assert.deepEqual(r.changed, []);
  assert.ok(r.observations.some((o) => o.kind === "integrity" && o.fingerprint === `${fingerprint(src, reuploaded)}|key:${keyId()}`));
});

test("an asset-ID-only change is a change of fingerprint too", () => {
  const a = rel("0.21.1", { ids: 7400 }), b = rel("0.21.1", { ids: 7500 });
  assert.notEqual(fingerprint(src, a), fingerprint(src, b));
  assert.equal(pinFingerprint(src, pinOf(a)), fingerprint(src, a));
});

test("a higher release still incomplete an hour after publishing opens incomplete-release; within the hour, nothing", async () => {
  const a = rel("0.21.1");
  const late = rel("0.22.0", { missing: ["pdfcraft-cli-0.22.0-linux-aarch64.tar.gz"], publishedAt: "2026-11-22T10:30:00Z" });
  const r = await run({ list: [late, a] }, pinOf(a));
  const o = r.observations.find((x) => x.kind === "incomplete-release")!;
  assert.equal(o.version, "0.22.0");
  assert.match(o.detail, /pdfcraft-cli-0.22.0-linux-aarch64/);
  const fresh = rel("0.22.0", { missing: ["SHA256SUMS.txt.asc"], publishedAt: "2026-11-22T11:30:00Z" });
  const r2 = await run({ list: [fresh, a] }, pinOf(a));
  assert.ok(!r2.observations.some((x) => x.kind === "incomplete-release"));
});

test("an open incomplete-release issue closes only on evidence for its release", async () => {
  const a = rel("0.21.1");
  // It became eligible.
  const ok = await run({ list: [rel("0.22.0"), a] }, pinOf(a), new Set(), false, ["0.22.0"]);
  assert.deepEqual(ok.observations.filter((o) => o.kind === "incomplete-ok").map((o) => [o.version, o.detail]), [["0.22.0", "0.22.0 became eligible"]]);
  // A higher eligible release that isn't pinned yet: not enough.
  const higher = await run({ list: [rel("0.23.0"), rel("0.22.0", { missing: ["SHA256SUMS.txt"] }), a] }, pinOf(a), new Set(), false, ["0.22.0"]);
  assert.ok(!higher.observations.some((o) => o.kind === "incomplete-ok"));
  // A higher release pinned on main.
  const pinned = await run({ list: [rel("0.23.0")] }, pinOf(rel("0.23.0")), new Set(), false, ["0.22.0"]);
  assert.match(pinned.observations.find((o) => o.kind === "incomplete-ok")!.detail, /0.23.0, is pinned/);
  // Withdrawn: confirmed deleted, or a draft again.
  const gone = await run({ list: [a], byTag: { "v0.22.0": null } }, pinOf(a), new Set(), false, ["0.22.0"]);
  assert.match(gone.observations.find((o) => o.kind === "incomplete-ok")!.detail, /withdrawn \(deleted\)/);
  const draft = await run({ list: [rel("0.22.0", { draft: true, missing: ["SHA256SUMS.txt"] }), a] }, pinOf(a), new Set(), false, ["0.22.0"]);
  assert.match(draft.observations.find((o) => o.kind === "incomplete-ok")!.detail, /a draft again/);
  // Still incomplete: stays open.
  const still = await run({ list: [rel("0.22.0", { missing: ["SHA256SUMS.txt"] }), a] }, pinOf(a), new Set(), false, ["0.22.0"]);
  assert.ok(!still.observations.some((o) => o.kind === "incomplete-ok"));
});

test("a listing not read far enough is unknown: resolve-failed, and the previous state stands", async () => {
  const a = rel("0.21.1");
  const r = await run({ list: [rel("0.22.0", { prerelease: true })], truncated: true }, pinOf(a));
  assert.deepEqual(r.changed, []);
  assert.deepEqual(kinds(r), ["resolve-failed"]);
});

test("a pulled pin (a prerelease again): main follows back after the tests; the downgrade issue waits for publish", async () => {
  const a = rel("0.21.0"), b = rel("0.21.1", { prerelease: true });
  const r = await run({ list: [b, a] }, pinOf(rel("0.21.1", { ids: Number(b.id) })));
  assert.deepEqual(r.changed.map((c) => [c.from, c.to]), [["0.21.1", "0.21.0"]]);
  assert.ok(!r.observations.some((o) => o.kind === "downgrade"), "only once the move has landed");
});

test("a pulled pin with no eligible release left stays, and the issue says so", async () => {
  const pin = pinOf(rel("0.41.1"));
  const r = await run({ list: [], byTag: { "v0.41.1": null } }, pin);
  assert.deepEqual(r.changed, []);
  assert.match(r.observations.find((o) => o.kind === "downgrade")!.detail, /no eligible release remains/);
});

test("a lower candidate while the pin wasn't pulled (the listing missed it) moves nothing", async () => {
  const a = rel("0.21.0"), pinned = rel("0.22.0");
  const r = await run({ list: [a], byTag: { "v0.22.0": pinned } }, pinOf(pinned));
  assert.deepEqual(r.changed, []);
});

test("unavailable: a pinned asset confirmed gone gets a marker, and the others carry on", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a);
  const cliId = pin.packages["pdfcraft-cli"]["x86_64-linux"].assetId;
  // The release lost the CLI's asset: not in the listing, and 404s.
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== cliId) };
  const r = await run({ list: [listed], gone: new Set([cliId]) }, pin);
  const changed = r.pins.get("pdfcraft")!;
  assert.deepEqual(changed.unavailable?.packages, ["pdfcraft-cli"]);
  assert.equal(changed.unavailable?.since, NOW.toISOString());
  assert.ok(r.observations.some((o) => o.kind === "unavailable"));
});

test("unavailable: a file replaced under the same name doesn't clear the marker (it's a same-tag change)", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft-cli"] } });
  const cliId = pin.packages["pdfcraft-cli"]["x86_64-linux"].assetId;
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== cliId) };
  const r = await run({ list: [listed], replaced: new Set([cliId]) }, pin);
  assert.deepEqual(r.changed, []);
});

test("unavailable: one package's asset replaced while another's is gone keeps both marked", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft", "pdfcraft-cli"] } });
  const cliId = pin.packages["pdfcraft-cli"]["x86_64-linux"].assetId;
  const guiId = pin.packages["pdfcraft"]["x86_64-linux"].assetId;
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== cliId && Number(x.id) !== guiId) };
  const r = await run({ list: [listed], gone: new Set([cliId]), replaced: new Set([guiId]) }, pin);
  assert.deepEqual(r.changed, [], "the GUI isn't confirmed back: its marker stays");
  assert.match(r.observations.find((o) => o.kind === "unavailable")!.detail, /pdfcraft, pdfcraft-cli/);
});

test("unavailable: one marked package back with its pinned assets, another replaced: the marker narrows", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft", "pdfcraft-cli"] } });
  const guiId = pin.packages["pdfcraft"]["x86_64-linux"].assetId;
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== guiId) };
  const r = await run({ list: [listed], replaced: new Set([guiId]) }, pin);
  assert.deepEqual(r.pins.get("pdfcraft")!.unavailable, { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft"] });
});

test("unavailable: the marked package back, another package's file replaced: the marker clears", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft-cli"] } });
  const guiId = pin.packages["pdfcraft"]["x86_64-linux"].assetId;
  const listed = { ...a, assets: a.assets.filter((x) => Number(x.id) !== guiId) };
  const r = await run({ list: [listed], replaced: new Set([guiId]) }, pin);
  assert.equal(r.pins.get("pdfcraft")?.unavailable, undefined);
});

test("unavailable: the assets coming back with the pinned digests clear the marker (the issue closes once main has it)", async () => {
  const a = rel("0.21.1");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft-cli"] } });
  const r = await run({ list: [a] }, pin);
  assert.equal(r.changed[0]?.why, "the assets came back with the pinned digests");
  assert.equal(r.pins.get("pdfcraft")!.unavailable, undefined);
  assert.ok(!r.observations.some((o) => o.kind === "available"), "not before the change lands");
  const after = await run({ list: [a] }, r.pins.get("pdfcraft")!);
  assert.ok(after.observations.some((o) => o.kind === "available"));
});

test("unavailable: a new eligible release clears it, tested like any change", async () => {
  const a = rel("0.21.1"), b = rel("0.22.0");
  const pin = pinOf(a, { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft"] } });
  const r = await run({ list: [b, a] }, pin);
  assert.equal(r.changed[0]?.to, "0.22.0");
  assert.equal(r.pins.get("pdfcraft")!.unavailable, undefined);
});

test("a pulled release that still downloads is not unavailable", async () => {
  const pinned = rel("0.41.1");
  const r = await run({ list: [], byTag: { "v0.41.1": null }, gone: new Set() }, pinOf(pinned));
  assert.ok(!r.observations.some((o) => o.kind === "unavailable"));
  assert.ok(r.observations.some((o) => o.kind === "downgrade"));
});

test("releases that can't be read: resolve-failed, and the previous state stands", async () => {
  const a = rel("0.21.1");
  const r = await run({ list: [], readError: "HTTP 500" }, pinOf(a));
  assert.deepEqual(r.changed, []);
  assert.deepEqual(kinds(r), ["resolve-failed"]);
});

test("the nixpkgs bump is due when an app release reached main since a bump a day old or more, or a week after it", () => {
  const t = NOW.getTime();
  assert.equal(bumpDue({ lockChangedAt: t - DAY_MS + 60_000, releaseSince: t - 60_000 }, NOW), null, "a bump less than a day ago");
  assert.match(bumpDue({ lockChangedAt: t - DAY_MS, releaseSince: t - 60_000 }, NOW)!, /app release/, "a release late in the day after a bump");
  assert.equal(bumpDue({ lockChangedAt: t - 2 * DAY_MS, releaseSince: null }, NOW), null, "no release since");
  assert.match(bumpDue({ lockChangedAt: t - 8 * DAY_MS, releaseSince: null }, NOW)!, /a week/);
});

test("in a run with app releases the cache check gets 60 seconds; otherwise the full budget", () => {
  const busy = new Report(NOW);
  busy.change({ repo: "photocraft", from: "1", to: "2", why: "a new release" });
  assert.equal(bumpBudget(busy).budget, RELEASE_RUN_BUMP_MS);
  assert.equal(RELEASE_RUN_BUMP_MS, 60_000);
  assert.equal(bumpBudget(new Report(NOW)).budget, BUMP_BUDGET_MS);
  // A held release this run will retry counts as an app release.
  const retrying = new Report(NOW);
  retrying.observe({ kind: "held", repo: "photocraft", version: "1", detail: "" });
  assert.equal(bumpBudget(retrying).budget, RELEASE_RUN_BUMP_MS);
  // A nixpkgs bump alone doesn't.
  const bumpOnly = new Report(NOW);
  bumpOnly.change({ repo: "nixpkgs", from: "a", to: "b", why: "" });
  assert.equal(bumpBudget(bumpOnly).budget, BUMP_BUDGET_MS);
});

test("the pinned release losing files isn't also an incomplete release; a release eligible below a held higher one closes its incomplete issue", async () => {
  const pinned = rel("0.21.1", { publishedAt: "2026-11-22T08:00:00Z" });
  const lost = { ...pinned, assets: pinned.assets.slice(1) };
  const r = await run({ list: [lost, rel("0.21.0")] }, pinOf(pinned));
  assert.ok(!r.observations.some((o) => o.kind === "incomplete-release"));
  const a = rel("0.21.1"), b = rel("0.22.0"), c = rel("0.23.0");
  const held = new Set([`pdfcraft\0${fingerprint(src, c)}`]);
  const r2 = await run({ list: [c, b, a] }, pinOf(a), held, false, ["0.22.0"]);
  assert.ok(r2.observations.some((o) => o.kind === "incomplete-ok" && o.version === "0.22.0" && /became eligible/.test(o.detail)));
});

test("the nixpkgs moves share one absolute deadline", async () => {
  const { bumpLeft } = await import("../scripts/update.ts");
  const r = new Report(NOW);
  r.change({ repo: "photocraft", from: "1", to: "2", why: "" });
  let t = 1_000_000;
  const clock = () => t;
  assert.equal(bumpLeft(r, clock, t, 20 * 60_000), 60_000);
  t += 25_000;
  assert.equal(bumpLeft(r, clock, t - 25_000, 20 * 60_000), 35_000, "the second move gets what's left");
});

test("probed: a read with no pass closes resolve-failed: no eligible release, and the NixOS channels", async () => {
  const pin = pinOf(rel("0.41.1"));
  const r = await run({ list: [], byTag: { "v0.41.1": rel("0.41.1") } }, pin);
  assert.ok(r.observations.some((o) => o.kind === "probed" && o.repo === pin.repo && !o.channel));
  const { maybeBumpStable, Report: R } = await import("../scripts/update.ts");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "stable-pin-"));
  mkdirSync(join(dir, "versions"));
  const rev = "b".repeat(40);
  writeFileSync(join(dir, "versions", "nixpkgs-stable.json"), JSON.stringify({ name: "nixpkgs-stable", channel: "nixos-26.05", rev, narHash: "sha256-x" }));
  const report = new R(NOW);
  const fakeIo = { released: async () => false, rev: async () => rev } as any;
  await maybeBumpStable(report, new Set(), NOW, () => NOW.getTime(), NOW.getTime(), 20 * 60_000, fakeIo, dir, { lockChangedAt: null, releaseSince: null } as any);
  assert.ok(report.observations.some((o) => o.kind === "probed" && o.repo === "nixpkgs-stable"), JSON.stringify(report.observations));
});

test("stableChecks: a replaced snapshot file, marked or not, makes no fetchable claim", async () => {
  const { stableChecks } = await import("../scripts/update.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const a = rel("0.21.1");
  for (const marked of [false, true]) {
    const pin = pinOf(a, marked ? { unavailable: { since: "2026-11-20T00:00:00Z", issue: 7, packages: ["pdfcraft"] } } : {});
    const guiId = pin.packages["pdfcraft"]["x86_64-linux"].assetId;
    const dir = mkdtempSync(join(tmpdir(), "stable-snap-"));
    writeFileSync(join(dir, "pdfcraft.json"), JSON.stringify(pin));
    const report = new Report(NOW);
    report.listings.set("pdfcraft", [{ ...a, assets: a.assets.filter((x) => Number(x.id) !== guiId) }]);
    await stableChecks(report, io({ list: [], replaced: new Set([guiId]) }), dir);
    const k = report.observations.map((o) => o.kind);
    assert.ok(!k.includes("fetchable") && !k.includes("available"), `${marked ? "marked" : "unmarked"}: ${k.join(", ")}`);
  }
});
