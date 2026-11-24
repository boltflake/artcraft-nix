// The release watcher (watcher/src/watcher.ts) against a fake GitHub
// (GraphQL and the dispatch), a fake KV and a fixed clock. Offline.
// Run: node --test tests/watcher.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ASSET_BUDGET, backoffUntil, health, HEARTBEAT_MS, KEY, MAX_BACKOFF_MS, run, TAGS_PER_ROUND, WATCH_MAX, type Env, type KV, type State } from "../watcher/src/watcher.ts";
import { readHealth, STALE_MS, STUCK_MS } from "../watcher/src/health.ts";
import { RECENT, RELEASE_PAGES, requiredNames, SOURCES, sourceOf } from "../shared/sources.ts";

const t0 = new Date(Date.UTC(2026, 10, 22, 12, 0));
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const GRAPHQL = "https://api.github.com/graphql";
const DISPATCH = "https://api.github.com/repos/boltflake/artcraft-nix/actions/workflows/update.yml/dispatches";

class FakeKV implements KV {
  data = new Map<string, string>();
  reads = 0;
  writes = 0;
  failWrites = false;
  failReads = false;
  async get(k: string) {
    if (this.failReads) throw new Error("KV down");
    this.reads++;
    return this.data.get(k) ?? null;
  }
  async put(k: string, v: string) {
    if (this.failWrites) throw new Error("quota");
    this.writes++;
    this.data.set(k, v);
  }
}
const saved = (kv: FakeKV): State => JSON.parse(kv.data.get(KEY)!);

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
interface FakeAsset { id: string; digest: string | null }
interface FakeRelease { tag: string; draft?: boolean; prerelease?: boolean; assets: Record<string, FakeAsset> }
const tagOf = (repo: string, version: string) => sourceOf(repo).prefix + version;
/** A release with every required asset uploaded; `gen` stands for an upload. */
function release(repo: string, version: string, gen = 1): FakeRelease {
  const assets: Record<string, FakeAsset> = {};
  for (const name of requiredNames(sourceOf(repo), version)) assets[name] = { id: `RA_${repo}_${name}_${gen}`, digest: `sha256:${hex(`${repo}/${name}/${gen}`)}` };
  return { tag: tagOf(repo, version), assets };
}
/** The same, missing the aarch64 tarball (still uploading). */
function incomplete(repo: string, version: string): FakeRelease {
  const r = release(repo, version);
  for (const name of Object.keys(r.assets)) if (name.includes("aarch64")) delete r.assets[name];
  return r;
}

/** The world: every repository's releases (newest created first; null: not
 * found), the pins on main, and how GitHub answers. Every repository starts
 * pinned at 1.0.0, with 0.9.0 under it. */
function world() {
  const w = {
    repos: Object.fromEntries(SOURCES.map((s) => [s.repo, [release(s.repo, "1.0.0"), release(s.repo, "0.9.0")]])) as Record<string, FakeRelease[] | null>,
    pins: Object.fromEntries(SOURCES.map((s) => [s.repo, tagOf(s.repo, "1.0.0")])) as Record<string, string>,
    pinsMissing: false,
    override: new Map<string, () => Response>(),
    /** Answers a GraphQL query instead of the world, when it returns one. */
    hook: null as ((query: string) => Response | null) | null,
    /** Pages from this one on (1: every page) say there are more but give
     * no cursor; 0: never. */
    dropCursor: 0,
    queries: [] as string[],
    dispatches: [] as any[],
  };
  const pinsOid = () => hex(JSON.stringify(w.pins)).slice(0, 40);
  function answer(query: string): any {
    const data: any = {};
    const errors: any[] = [];
    const heads = [...query.matchAll(/(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{/g)];
    heads.forEach((m, k) => {
      const [, alias, owner, name] = m;
      const body = query.slice(m.index! + m[0].length, heads[k + 1]?.index ?? query.length);
      if (owner === "boltflake") {
        if (w.pinsMissing) {
          data[alias] = null;
          errors.push({ type: "NOT_FOUND", path: [alias] });
        } else if (body.includes(`object(expression: "main:versions")`)) {
          data[alias] = { object: { oid: pinsOid() } };
        } else {
          const oid = /object\(oid: "([^"]+)"\)/.exec(body)![1];
          data[alias] = { object: oid === pinsOid() ? { entries: Object.entries(w.pins).map(([repo, tag]) => ({ name: `${repo}.json`, object: { text: JSON.stringify({ repo, tag }) } })) } : null };
        }
        return;
      }
      const rels = w.repos[name];
      if (!rels) {
        data[alias] = null;
        errors.push({ type: "NOT_FOUND", path: [alias], message: `Could not resolve to a Repository with the name '${owner}/${name}'.` });
        return;
      }
      // Drafts aren't visible to the watcher's token.
      const visible = rels.filter((r) => !r.draft);
      const list = /releases\(first: (\d+)(?:, after: "o(\d+)")?/.exec(body);
      if (list) {
        const from = Number(list[2] ?? 0), n = Number(list[1]);
        const nodes = visible.slice(from, from + n).map((r, i) => ({ databaseId: 1000 + i, tagName: r.tag, isDraft: false, isPrerelease: Boolean(r.prerelease), publishedAt: "2026-11-20T00:00:00Z" }));
        data[alias] = { releases: { pageInfo: { hasNextPage: from + n < visible.length, endCursor: w.dropCursor && from / n + 1 >= w.dropCursor ? null : `o${from + n}` }, nodes } };
        return;
      }
      const tag = /release\(tagName: "([^"]+)"\)/.exec(body)![1];
      const r = visible.find((x) => x.tag === tag);
      if (!r) {
        data[alias] = { release: null };
        return;
      }
      const fields: any = {};
      for (const [, a, asset] of body.matchAll(/(a\d+): releaseAssets\(first: 1, name: "([^"]+)"\)/g)) {
        const x = r.assets[asset];
        fields[a] = { nodes: x ? [{ name: asset, id: x.id, digest: x.digest, size: 10 }] : [] };
      }
      data[alias] = { release: { isDraft: false, isPrerelease: Boolean(r.prerelease), ...fields } };
    });
    return errors.length ? { data, errors } : { data };
  }
  const f = async (url: string, init?: RequestInit) => {
    const o = w.override.get(url);
    if (url === GRAPHQL) w.queries.push(JSON.parse(init!.body as string).query);
    if (o) return o();
    if (url === GRAPHQL) {
      const q = w.queries.at(-1)!;
      return w.hook?.(q) ?? Response.json(answer(q));
    }
    if (url === DISPATCH) {
      w.dispatches.push(JSON.parse(init!.body as string));
      return new Response(null, { status: 204 });
    }
    return new Response("no", { status: 404 });
  };
  return { w, f: f as (url: string, init?: RequestInit) => Promise<Response> };
}
/** A follow-up page of this repository's own release list. */
const pageAfter = (repo: string) => new RegExp(`name: "${repo}"\\) \\{\\s*releases\\(first: \\d+, after:`);
const env = (kv: FakeKV): Env => ({ STATE: kv, GITHUB_TOKEN: "t", HEALTH_TOKEN: "h", REPO: "boltflake/artcraft-nix", CF_VERSION: { id: "v1" } });
const eligible = (s: State) => Object.fromEntries(Object.entries(s.repos).map(([repo, r]) => [repo, r.eligible?.version ?? null]));
/** A world after one good first sweep. */
async function started() {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(env(kv), t0, f);
  w.queries.length = 0;
  w.dispatches.length = 0;
  return { kv, w, f };
}

test("watcher: first sight reads the pins and each pin's assets, records every repository and dispatches once", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const r = await run(env(kv), t0, f);
  assert.ok(r.written);
  assert.deepEqual(eligible(r.state), Object.fromEntries(SOURCES.map((s) => [s.repo, "1.0.0"])));
  for (const s of SOURCES) {
    const repo = r.state.repos[s.repo];
    assert.equal(repo.pinned?.tag, tagOf(s.repo, "1.0.0"));
    assert.equal(repo.pinned?.fingerprint, repo.eligible?.fingerprint);
    assert.deepEqual([repo.waiting, repo.read, repo.error], [{}, t0.toISOString(), undefined]);
  }
  assert.deepEqual(w.dispatches, [{ ref: "main" }], "one dispatch, for main");
  assert.equal(r.state.dispatch.pending, false);
  // The first query, the pins (their tree was new), then the pins' assets:
  // the releases under each pin are never read.
  assert.equal(w.queries.length, 3);
  assert.match(w.queries[1], /object\(oid:/);
  assert.ok(!w.queries.some((q) => q.includes(`tagName: "v0.9.0"`)));
  assert.deepEqual([kv.reads, kv.writes], [1, 1]);
});

test("watcher: a quiet minute is one query and no write, until the heartbeat", async () => {
  const { kv, w, f } = await started();
  const writes = kv.writes;
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.written, r.dispatched, w.queries.length], [false, false, 1]);
  // The pins' tree is unchanged, so only its ID is asked; each pin's assets come in the same query.
  assert.ok(!w.queries[0].includes("object(oid:"));
  assert.equal((w.queries[0].match(/release\(tagName:/g) ?? []).length, SOURCES.length);
  for (let m = 2; m < HEARTBEAT_MS / 60_000; m++) await run(env(kv), at(m), f);
  assert.equal(kv.writes, writes);
  assert.equal((await run(env(kv), at(HEARTBEAT_MS / 60_000), f)).written, true);
  assert.equal(w.dispatches.length, 0);
});

test("watcher: several new tags: the highest eligible is taken, the incomplete ones above it wait, and one that becomes eligible later dispatches", async () => {
  const { kv, w, f } = await started();
  const p = "photocraft";
  const v13 = incomplete(p, "1.3.0");
  w.repos[p]!.unshift(v13, incomplete(p, "1.2.0"), release(p, "1.1.0"));
  v13.assets[`photocraft-1.3.0-linux-x86_64.tar.gz`].digest = null; // not uploaded yet either
  const r1 = await run(env(kv), at(1), f);
  assert.equal(r1.state.repos[p].eligible?.version, "1.1.0");
  assert.deepEqual(Object.keys(r1.state.repos[p].waiting).sort(), ["v1.2.0", "v1.3.0"]);
  assert.equal(r1.state.repos[p].waiting["v1.3.0"].firstSeen, at(1).toISOString());
  assert.deepEqual([r1.dispatched, r1.written, w.queries.length], [true, true, 2], "the new tags' assets took one follow-up");
  // Next minute: nothing new; the window (pin, eligible, waiting) is read in the one query.
  const r2 = await run(env(kv), at(2), f);
  assert.deepEqual([r2.dispatched, r2.written, w.queries.length], [false, false, 3]);
  assert.match(w.queries[2], /tagName: "v1\.3\.0"/);
  // 1.3.0's files arrive, with no new tag: it becomes the eligible one and nothing waits.
  w.repos[p]![0] = release(p, "1.3.0");
  const r3 = await run(env(kv), at(3), f);
  assert.deepEqual([r3.state.repos[p].eligible?.version, r3.state.repos[p].waiting, r3.dispatched, w.queries.length], ["1.3.0", {}, true, 4]);
  assert.equal(r3.state.repos[p].eligible?.firstSeen, at(3).toISOString());
  assert.equal(r3.state.repos[p].pinned?.tag, "v1.0.0", "the pin is the updater's");
});

test("watcher: a draft never waits, a prerelease is never taken, and the other repositories are untouched", async () => {
  const { kv, w, f } = await started();
  w.repos.vectorcraft!.unshift({ ...release("vectorcraft", "2.0.0"), draft: true }, { ...release("vectorcraft", "1.5.0"), prerelease: true });
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.state.repos.vectorcraft.eligible?.version, r.state.repos.vectorcraft.waiting, r.dispatched], ["1.0.0", {}, false]);
  // Studio's tags have their own prefix.
  w.repos.artcraft!.unshift(release("artcraft", "1.1.0"), { tag: "v9.0.0", assets: {} });
  const r2 = await run(env(kv), at(2), f);
  assert.deepEqual([r2.state.repos.artcraft.eligible?.tag, r2.dispatched], ["artcraft-v1.1.0", true]);
});

test("watcher: \"the highest\" is by semver, also when a backport is published after a newer release", async () => {
  const { kv, w, f } = await started();
  const p = "pdfcraft";
  w.repos[p]!.unshift(release(p, "1.1.0"));
  assert.equal((await run(env(kv), at(1), f)).state.repos[p].eligible?.version, "1.1.0");
  w.queries.length = 0;
  w.dispatches.length = 0;
  // A backport, created after 1.1.0 (newest in the list), under the pin's line.
  w.repos[p]!.unshift(release(p, "1.0.1"));
  const r = await run(env(kv), at(2), f);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.dispatched, r.written, w.queries.length], ["1.1.0", false, false, 1]);
  assert.ok(!w.queries.some((q) => q.includes(`tagName: "v1.0.1"`)), "a release below the eligible one is never read");
  // One under the pin, too.
  w.repos[p]!.unshift(release(p, "0.9.5"));
  assert.equal((await run(env(kv), at(3), f)).dispatched, false);
});

test("watcher: a pulled pin falls back to the release under it, and a deleted one too", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  w.repos[p]![0].prerelease = true;
  const r1 = await run(env(kv), at(1), f);
  assert.equal(r1.state.repos[p].eligible?.version, "0.9.0", "a known tag under the pin became the highest: its assets were read");
  assert.deepEqual([r1.dispatched, w.queries.length], [true, 2]);
  assert.ok(r1.state.repos[p].pinned?.fingerprint, "its files are still there");
  assert.equal(r1.state.repos[p].pinned?.pulled, true, "a prerelease again: pulled");
  // Deleted outright: the pinned release is gone.
  w.repos[p]!.shift();
  const r2 = await run(env(kv), at(2), f);
  assert.deepEqual([r2.state.repos[p].pinned, r2.state.repos[p].eligible?.version, r2.dispatched], [{ tag: "v1.0.0", fingerprint: null, pulled: true }, "0.9.0", true]);
  // Its files come back: a change.
  w.repos[p]!.unshift(release(p, "1.0.0"));
  const r3 = await run(env(kv), at(3), f);
  assert.deepEqual([r3.state.repos[p].eligible?.version, r3.dispatched], ["1.0.0", true]);
  assert.equal(r3.state.repos[p].pinned?.pulled, false);
});

test("watcher: a pulled pin reads the whole window: the release before it on the next page beats a backport on the first", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  // The pin is item 29, a prerelease item 30, 0.9.0 (before the pin) item
  // 31; a backport created since the pin is item 1.
  const list = w.repos[p]!;
  list[0].prerelease = true;
  list.splice(1, 0, { ...release(p, "0.9.1-rc.1"), prerelease: true });
  for (let k = 0; k < RECENT - 3; k++) list.unshift({ ...release(p, `2.0.${k}`), prerelease: true });
  list.unshift(release(p, "0.8.5"));
  assert.equal(list.findIndex((r) => r.tag === "v1.0.0"), RECENT - 2);
  const r1 = await run(env(kv), at(1), f);
  assert.equal(r1.state.repos[p].eligible?.version, "0.9.0");
  assert.equal(r1.state.repos[p].pinned?.pulled, true);
  assert.equal(r1.dispatched, true);
});

test("watcher: a pulled pin on a list longer than the window falls back within it, and dispatches", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  for (let k = 0; k < RELEASE_PAGES * RECENT; k++) list.push(release(p, `0.8.${k}`));
  // Past the window: never read, though higher.
  list.push(release(p, "0.9.5"));
  await run(env(kv), at(1), f);
  list[0].prerelease = true;
  w.queries.length = 0;
  const r = await run(env(kv), at(2), f);
  assert.equal(r.state.repos[p].error, undefined);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.state.repos[p].pinned?.pulled, r.dispatched], ["0.9.0", true, true]);
  assert.equal(w.queries.filter((q) => pageAfter(p).test(q)).length, RELEASE_PAGES - 1, "the whole window, and no more");
});

test("watcher: a pulled pin with a higher eligible release already known: settled by it, on a list longer than the window", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  for (let k = 0; k < RELEASE_PAGES * RECENT; k++) list.push(release(p, `0.8.${k}`));
  // 1.1.0 eligible while main stays on 1.0.0 (its tests fail, say).
  list.unshift(release(p, "1.1.0"));
  const r1 = await run(env(kv), at(1), f);
  assert.equal(r1.state.repos[p].eligible?.version, "1.1.0");
  list.find((r) => r.tag === "v1.0.0")!.prerelease = true;
  w.queries.length = 0;
  const r2 = await run(env(kv), at(2), f);
  assert.equal(r2.state.repos[p].error, undefined);
  assert.deepEqual([r2.state.repos[p].eligible?.version, r2.state.repos[p].pinned?.pulled, r2.dispatched], ["1.1.0", true, true]);
  assert.equal(w.queries.filter((q) => pageAfter(p).test(q)).length, RELEASE_PAGES - 1, "the whole window");
});

test("watcher: a pulled pin above many published releases still uploading, the eligible one last in the window: sweeps converge", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  list.splice(1);
  for (let k = 0; k < RELEASE_PAGES * RECENT - 2; k++) list.push(incomplete(p, `0.8.${100 - k}`));
  list.push(release(p, "0.5.0"), release(p, "0.4.0"));
  await run(env(kv), at(1), f);
  list[0].prerelease = true;
  let settled = -1;
  for (let i = 0; i < 40 && settled < 0; i++) {
    w.queries.length = 0;
    const r = await run(env(kv), at(2 + i), f);
    assert.ok(w.queries.length <= 1 + ASSET_BUDGET, `a sweep within its budget (${w.queries.length} queries)`);
    if (r.state.repos[p].eligible?.version === "0.5.0") settled = i;
    else assert.ok((r.state.repos[p].watch ?? []).length > 0 || i === 0, "progress is kept between sweeps");
  }
  assert.ok(settled >= 0, "the fallback is found");
  assert.equal(saved(kv).repos[p].pinned?.pulled, true);
});

test("watcher: no cursor after the window's last page: the window is read, and a pulled pin settles", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  for (let k = 0; k < RELEASE_PAGES * RECENT; k++) list.push(release(p, `0.8.${k}`));
  await run(env(kv), at(1), f);
  list[0].prerelease = true;
  w.dropCursor = RELEASE_PAGES;
  const r = await run(env(kv), at(2), f);
  assert.equal(r.state.repos[p].error, undefined);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.state.repos[p].pinned?.pulled], ["0.9.0", true]);
  // Missing on an earlier page: not read in full.
  w.dropCursor = 2;
  list.unshift(release(p, "0.9.9"));
  const r2 = await run(env(kv), at(3), f);
  assert.equal(r2.state.repos[p].error?.kind, "parse");
});

test("watcher: a pin past the window, a prerelease by tag, above many releases still uploading: sweeps converge on the one in the window", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  list[0].prerelease = true;
  // 89 uploading above 1.1.0 (item 90); the pin is item 91.
  list.unshift(release(p, "1.1.0"));
  for (let k = 0; k < RELEASE_PAGES * RECENT - 1; k++) list.unshift(incomplete(p, `1.2.${k}`));
  assert.equal(list.findIndex((r) => r.tag === "v1.0.0"), RELEASE_PAGES * RECENT);
  let settled = -1;
  for (let i = 0; i < 40 && settled < 0; i++) {
    w.queries.length = 0;
    const r = await run(env(kv), at(1 + i), f);
    assert.ok(w.queries.length <= 1 + ASSET_BUDGET, `a sweep within its budget (${w.queries.length} queries)`);
    if (r.state.repos[p].eligible?.version === "1.1.0") settled = i;
    else assert.ok((r.state.repos[p].watch ?? []).length > 0 || i === 0, "progress is kept between sweeps");
  }
  assert.ok(settled >= 0, "the release in the window is found");
  assert.equal(saved(kv).repos[p].pinned?.pulled, true);
});

test("watcher: more releases with no cursor to them: not read in full, nothing settles on a part of the window", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  list[0].prerelease = true;
  // The pulled pin and a backport on page one; 0.9.0 on page two.
  list.splice(1, 0, release(p, "0.8.5"), ...Array.from({ length: RECENT - 2 }, (_, k) => ({ ...release(p, `0.8.6-rc.${k}`), prerelease: true })));
  w.dropCursor = 1;
  const r = await run(env(kv), at(1), f);
  assert.equal(r.state.repos[p].error?.kind, "parse");
  assert.notEqual(r.state.repos[p].eligible?.version, "0.8.5");
  w.dropCursor = 0;
  const r2 = await run(env(kv), at(2), f);
  assert.equal(r2.state.repos[p].eligible?.version, "0.9.0");
});

test("watcher: a pin past the window, read by tag as a prerelease again: a release in the window stands in", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  const list = w.repos[p]!;
  list[0].prerelease = true;
  // 1.1.0 first, then prereleases to push the pin to item 91.
  for (let k = 0; k < RELEASE_PAGES * RECENT - 1; k++) list.unshift({ ...release(p, `1.0.1-rc.${k}`), prerelease: true });
  list.unshift(release(p, "1.1.0"));
  assert.equal(list.findIndex((r) => r.tag === "v1.0.0"), RELEASE_PAGES * RECENT);
  let r = await run(env(kv), at(1), f);
  for (let i = 2; i < 6 && r.state.repos[p].eligible?.version !== "1.1.0"; i++) r = await run(env(kv), at(i), f);
  assert.equal(r.state.repos[p].error, undefined);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.state.repos[p].pinned?.pulled], ["1.1.0", true]);
});

test("watcher: lower releases created since the pin (backports) don't stop the listing short of the pin; a pull alone dispatches", async () => {
  const { kv, w, f } = await started();
  const p = "lightcraft";
  // Lower releases created since the pin fill the first page, and a higher
  // one was created between the pin and them: the list reads on to the pin.
  w.repos[p]!.unshift(release(p, "1.1.0"));
  for (let k = 0; k < RECENT; k++) w.repos[p]!.unshift(release(p, `0.9.${50 + k}`));
  const r1 = await run(env(kv), at(1), f);
  assert.equal(r1.state.repos[p].eligible?.version, "1.1.0", "the upgrade behind the backports is found");
  assert.ok(w.queries.some((q) => q.includes(`after:`) && q.includes(`"${p}"`)), "a second page");
  w.queries.length = 0;
  w.repos[p]!.find((r) => r.tag === "v1.1.0")!.prerelease = true;
  w.repos[p]!.find((r) => r.tag === "v1.0.0")!.prerelease = true;
  const r2 = await run(env(kv), at(2), f);
  assert.equal(r2.state.repos[p].pinned?.pulled, true, "a prerelease again, as listed");
  assert.equal(r2.dispatched, true);
});

test("watcher: a withdrawn eligible release makes the pin the highest again", async () => {
  const { kv, w, f } = await started();
  const p = "effectcraft";
  w.repos[p]!.unshift(release(p, "1.1.0"));
  await run(env(kv), at(1), f);
  w.queries.length = 0;
  w.repos[p]!.shift();
  const r = await run(env(kv), at(2), f);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.dispatched, w.queries.length], ["1.0.0", true, 1]);
  // A waiting tag withdrawn (a draft again) dispatches too, so its issue can close.
  w.repos[p]!.unshift(incomplete(p, "1.2.0"));
  assert.deepEqual(Object.keys((await run(env(kv), at(3), f)).state.repos[p].waiting), ["v1.2.0"]);
  w.repos[p]![0].draft = true;
  const r2 = await run(env(kv), at(4), f);
  assert.deepEqual([r2.state.repos[p].waiting, r2.dispatched], [{}, true]);
});

test("watcher: releases are paged until the pin; past the page limit the list is unknown and the old state stands", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const p = "anicraft";
  const junk = (n: number) => Array.from({ length: n }, (_, i) => ({ tag: `nightly-${i}`, assets: {} }) as FakeRelease);
  w.repos[p]!.unshift(...junk(RECENT + 5));
  const r = await run(env(kv), t0, f);
  assert.equal(r.state.repos[p].eligible?.version, "1.0.0");
  assert.equal(w.queries.filter((q) => q.includes(`after: "o${RECENT}"`)).length, 1, "a second page");
  // Now a new release, behind more releases than the readers page through.
  w.queries.length = 0;
  w.repos[p] = [...junk(RECENT * RELEASE_PAGES), release(p, "1.1.0"), ...w.repos[p]!];
  const r2 = await run(env(kv), at(1), f);
  assert.deepEqual([r2.state.repos[p].eligible?.version, r2.state.repos[p].error?.kind, r2.dispatched, r2.written], ["1.0.0", "truncated", false, false]);
  assert.equal(r2.state.repos[p].read, t0.toISOString(), "not fresh");
  assert.equal(w.queries.length, RELEASE_PAGES);
  // The error waits for the heartbeat.
  await run(env(kv), at(HEARTBEAT_MS / 60_000), f);
  assert.equal(saved(kv).repos[p].error?.kind, "truncated");
  assert.equal(saved(kv).repos.photocraft.error, undefined);
});

test("watcher: a follow-up that fails leaves the repositories it was for unknown; the others are read", async () => {
  const { kv, w, f } = await started();
  const p = "designcraft";
  w.repos[p]!.unshift(...Array.from({ length: RECENT }, (_, i) => ({ tag: `ci-${i}`, assets: {} }) as FakeRelease));
  // photocraft's new tag is read in the same follow-up as designcraft's second page.
  w.repos.photocraft!.unshift(release("photocraft", "1.1.0"));
  w.hook = (q) => (q.includes("after:") ? new Response("down", { status: 502 }) : null);
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.state.repos[p].eligible?.version, r.state.repos[p].error?.kind, r.state.repos[p].read], ["1.0.0", "http", t0.toISOString()]);
  assert.deepEqual([r.state.repos.photocraft.eligible?.version, r.state.repos.photocraft.error?.kind], ["1.0.0", "http"]);
  assert.deepEqual([r.state.repos.vectorcraft.read, r.state.repos.vectorcraft.error, r.dispatched], [at(1).toISOString(), undefined, false]);
  w.hook = null;
  const r2 = await run(env(kv), at(2), f);
  assert.deepEqual([r2.state.repos.photocraft.eligible?.version, r2.state.repos[p].error, r2.dispatched], ["1.1.0", undefined, true]);
});

test("watcher: fingerprints: an asset-ID-only change, a re-upload, and a repaired upload on a held release dispatch", async () => {
  const { kv, w, f } = await started();
  const p = "texturecraft";
  // The same bytes under a new asset ID on the pinned release.
  const manifest = w.repos[p]![0].assets["SHA256SUMS.txt"];
  manifest.id = "RA_new";
  const r1 = await run(env(kv), at(1), f);
  assert.deepEqual([r1.dispatched, r1.state.repos[p].eligible?.version], [true, "1.0.0"]);
  assert.equal((await run(env(kv), at(2), f)).dispatched, false, "seen once");
  // A higher release, held by the updater (the pin stays): its signature
  // is re-uploaded with new bytes, and that is a new input.
  w.repos[p]!.unshift(release(p, "1.1.0"));
  await run(env(kv), at(3), f);
  const before = saved(kv).repos[p].eligible!.fingerprint;
  w.repos[p]![0].assets["SHA256SUMS.txt.asc"] = { id: "RA_sig2", digest: `sha256:${hex("repaired")}` };
  const r2 = await run(env(kv), at(4), f);
  assert.deepEqual([r2.dispatched, r2.state.repos[p].eligible?.version], [true, "1.1.0"]);
  assert.notEqual(r2.state.repos[p].eligible!.fingerprint, before);
  assert.equal(r2.state.repos[p].eligible!.firstSeen, at(4).toISOString(), "a re-upload is first seen again");
  // New bytes under the pin while a higher release is held: the pin's own fingerprint.
  w.repos[p]![1].assets["texturecraft-1.0.0-linux-x86_64.tar.gz"].digest = `sha256:${hex("rebuilt")}`;
  const r3 = await run(env(kv), at(5), f);
  assert.equal(r3.dispatched, true);
  assert.equal(w.queries.length, 6, "each a single query: nothing outside the window");
});

test("watcher: the pin moving on main is saved, not dispatched; a same-tag change at the same time still is", async () => {
  const { kv, w, f } = await started();
  const p = "materialcraft";
  w.repos[p]!.unshift(release(p, "1.1.0"));
  await run(env(kv), at(1), f);
  w.dispatches.length = 0;
  w.queries.length = 0;
  w.pins[p] = "v1.1.0";
  const r = await run(env(kv), at(2), f);
  assert.deepEqual([r.written, r.dispatched, r.state.pins.tags[p], r.state.repos[p].pinned?.tag], [true, false, "v1.1.0", "v1.1.0"]);
  assert.equal(w.queries.length, 2, "the pins, read once their tree changed");
  // The pin moves back, and the release it moves onto was re-uploaded meanwhile.
  w.pins[p] = "v1.0.0";
  w.repos[p]![1] = release(p, "1.0.0", 2);
  w.repos[p]!.shift(); // 1.1.0 withdrawn
  const r2 = await run(env(kv), at(3), f);
  assert.deepEqual([r2.state.repos[p].eligible?.version, r2.dispatched], ["1.0.0", true]);
});

test("watcher: the follow-up budget runs out across repositories: what was decided counts, the rest keeps its state and gets there next time", async () => {
  const { kv, w, f } = await started();
  // photocraft: 20 new tags, none eligible yet (5 follow-ups' worth); filmcraft: 9; vectorcraft: one ready.
  const many = (repo: string, n: number) => Array.from({ length: n }, (_, i) => incomplete(repo, `1.${n - i}.0`));
  w.repos.photocraft!.unshift(...many("photocraft", 5 * TAGS_PER_ROUND));
  w.repos.filmcraft!.unshift(...many("filmcraft", 2 * TAGS_PER_ROUND + 1));
  w.repos.vectorcraft!.unshift(release("vectorcraft", "1.1.0"));
  const r1 = await run(env(kv), at(1), f);
  assert.equal(w.queries.length, 1 + ASSET_BUDGET);
  assert.equal(r1.state.repos.vectorcraft.eligible?.version, "1.1.0");
  assert.equal(Object.keys(r1.state.repos.filmcraft.waiting).length, 2 * TAGS_PER_ROUND + 1);
  assert.deepEqual([r1.state.repos.photocraft.eligible?.version, r1.state.repos.photocraft.waiting, r1.state.repos.photocraft.error?.kind],
    ["1.0.0", {}, "budget"], "unknown: the old state stands");
  assert.equal(r1.state.repos.photocraft.watch?.length, ASSET_BUDGET * TAGS_PER_ROUND);
  assert.deepEqual([r1.dispatched, r1.written], [true, true]);
  // Next minute: the tags read so far come in the first query, and the rest in one follow-up.
  w.queries.length = 0;
  const r2 = await run(env(kv), at(2), f);
  assert.equal(w.queries.length, 2);
  assert.equal(Object.keys(r2.state.repos.photocraft.waiting).length, 5 * TAGS_PER_ROUND);
  assert.deepEqual([r2.state.repos.photocraft.error, r2.state.repos.photocraft.watch, r2.dispatched], [undefined, undefined, true]);
});

test("watcher: a repository needing every page and many asset rounds, while the pins move, settles in a bounded number of sweeps", async () => {
  const { kv, w, f } = await started();
  const p = "photocraft";
  // 40 tags still uploading, behind enough other releases that the pin is on the third page.
  const n = 40;
  const tags = Array.from({ length: n }, (_, i) => incomplete(p, `1.${n - i}.0`));
  const junk = Array.from({ length: 2 * RECENT - n }, (_, i) => ({ tag: `nightly-${i}`, assets: {} }) as FakeRelease);
  w.repos[p]!.unshift(...tags, ...junk);
  assert.ok(n > 24, "more than the old watch list held");
  w.pins.filmcraft = "v0.9.0"; // the pins' tree changes: a round of its own
  let sweeps = 0;
  const bound = Math.ceil(n / TAGS_PER_ROUND);
  for (let m = 1; m <= bound; m++) {
    sweeps++;
    const r = await run(env(kv), at(m), f);
    if (!r.state.repos[p].error) break;
    assert.equal(r.state.repos[p].error?.kind, "budget");
    // Every remembered tag still matters, and the list only grows.
    assert.ok((r.state.repos[p].watch ?? []).every((t) => tags.some((x) => x.tag === t)));
  }
  const s = saved(kv).repos[p];
  assert.deepEqual([s.error, s.watch, Object.keys(s.waiting).length, s.eligible?.version], [undefined, undefined, n, "1.0.0"]);
  assert.ok(sweeps <= bound, `${sweeps} sweeps`);
  assert.equal(WATCH_MAX, RELEASE_PAGES * RECENT);
});

test("watcher: remembered tags that no longer matter are dropped", async () => {
  const { kv, w, f } = await started();
  const p = "filmcraft";
  w.repos[p]!.unshift(...Array.from({ length: (ASSET_BUDGET + 1) * TAGS_PER_ROUND }, (_, i) => incomplete(p, `1.${20 - i}.0`)));
  await run(env(kv), at(1), f);
  const watch = saved(kv).repos[p].watch!;
  assert.equal(watch.length, ASSET_BUDGET * TAGS_PER_ROUND);
  // The highest four are withdrawn, and one under them is published complete: everything below it stops mattering.
  w.repos[p]!.splice(0, 4);
  w.repos[p]![4] = release(p, "1.12.0");
  w.repos.photocraft!.unshift(...Array.from({ length: (ASSET_BUDGET + 2) * TAGS_PER_ROUND }, (_, i) => incomplete("photocraft", `1.${30 - i}.0`)));
  const r = await run(env(kv), at(2), f);
  assert.deepEqual([r.state.repos[p].eligible?.version, Object.keys(r.state.repos[p].waiting).sort(), r.state.repos[p].watch],
    ["1.12.0", ["v1.13.0", "v1.14.0", "v1.15.0", "v1.16.0"], undefined]);
  // photocraft ran out of budget: its list holds only tags it read that still matter, highest first.
  const pw = r.state.repos.photocraft.watch!;
  assert.deepEqual(pw, [...pw].sort((a, b) => Number(b.split(".")[1]) - Number(a.split(".")[1])));
});

test("watcher: a repository that isn't found is reported alone; so are pins that can't be read", async () => {
  const { kv, w, f } = await started();
  w.repos.gridcraft = null;
  w.repos.photocraft!.unshift(release("photocraft", "1.1.0"));
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.state.repos.gridcraft.error?.kind, r.state.repos.gridcraft.eligible?.version], ["not-found", "1.0.0"]);
  assert.deepEqual([r.state.repos.photocraft.eligible?.version, r.state.poll.error, r.dispatched], ["1.1.0", undefined, true]);
  w.pinsMissing = true;
  const r2 = await run(env(kv), at(2), f);
  assert.equal(r2.state.pins.error?.kind, "not-found");
  assert.equal(r2.state.pins.tags.photocraft, "v1.0.0", "the pins last read stand");
  assert.equal(r2.state.repos.photocraft.error, undefined);
});

test("watcher: an HTTP 200 GraphQL reply with other errors fails the sweep, and nothing changes", async () => {
  const { kv, w, f } = await started();
  w.override.set(GRAPHQL, () => Response.json({ data: { r0: null }, errors: [{ type: "NOT_FOUND", path: ["r0"] }, { type: "FORBIDDEN", message: "no" }] }));
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.state.poll.error?.kind, r.dispatched, r.written], ["auth", false, false]);
  w.override.set(GRAPHQL, () => Response.json({ errors: [{ message: "Something went wrong" }] }));
  const r2 = await run(env(kv), at(2), f);
  assert.equal(eligible(r2.state).photocraft, "1.0.0");
  // A failure keeps its first `since` while its kind changes (once saved: here by a first write).
  const kv2 = new FakeKV();
  w.override.set(GRAPHQL, () => Response.json({ errors: [{ type: "FORBIDDEN" }] }));
  await run(env(kv2), at(1), f);
  w.override.set(GRAPHQL, () => Response.json({ errors: [{ message: "Something went wrong" }] }));
  const r2b = await run(env(kv2), at(2), f);
  assert.deepEqual([r2b.state.poll.error?.kind, r2b.state.poll.error?.since], ["parse", at(1).toISOString()]);
  const r3 = await run(env(new FakeKV()), at(2), f);
  assert.deepEqual(r3.state.repos, {});
});

test("watcher: back-off: a rate limit isn't polled through, a long one is saved at once, and an absurd one is cut to an hour", async () => {
  const { kv, w, f } = await started();
  w.override.set(GRAPHQL, () => new Response("slow down", { status: 403, headers: { "retry-after": "300", "x-ratelimit-remaining": "0" } }));
  // Shorter than a heartbeat, but it would skip the next sweeps: saved at
  // once, so the next cron run (a fresh isolate, the state from KV) doesn't
  // ask through it.
  const r1 = await run(env(kv), at(1), f);
  assert.deepEqual([r1.state.poll.error?.kind, r1.state.poll.retryAt, r1.written], ["rate-limit", at(6).toISOString(), true]);
  assert.equal(saved(kv).poll.retryAt, at(6).toISOString());
  const asked = w.queries.length;
  for (let m = 2; m <= 5; m++) await run(env(kv), at(m), f);
  assert.equal(w.queries.length, asked, "not polled while backed off");
  // One that's over by the next minute isn't worth a write.
  const kv2 = new FakeKV();
  w.override.delete(GRAPHQL);
  await run(env(kv2), at(1), f);
  const writes2 = kv2.writes;
  w.override.set(GRAPHQL, () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }));
  const r1b = await run(env(kv2), at(2), f);
  assert.deepEqual([r1b.state.poll.retryAt, r1b.written, kv2.writes], [at(3).toISOString(), false, writes2]);
  w.override.delete(GRAPHQL);
  const r2 = await run(env(kv), at(6), f);
  assert.deepEqual([r2.state.poll.error, r2.state.poll.retryAt, r2.state.poll.retryMs], [undefined, undefined, undefined]);
  // GitHub's GraphQL limit: HTTP 200, RATE_LIMITED, the reset time in a header. Over a heartbeat away: saved at once.
  const reset = String(Math.floor(at(30).getTime() / 1000));
  w.override.set(GRAPHQL, () => Response.json({ errors: [{ type: "RATE_LIMITED" }] }, { headers: { "x-ratelimit-reset": reset } }));
  const r3 = await run(env(new FakeKV()), at(7), f);
  assert.deepEqual([r3.state.poll.retryAt, r3.written], [at(30).toISOString(), true]);
  // Ten years: an hour.
  w.override.set(GRAPHQL, () => new Response("slow", { status: 429, headers: { "retry-after": "315360000" } }));
  const r4 = await run(env(new FakeKV()), at(7), f);
  assert.equal(r4.state.poll.retryAt, at(67).toISOString());
  assert.equal(backoffUntil(NaN, t0.getTime()), null);
  // A stored back-off beyond the cap is ignored.
  w.override.delete(GRAPHQL);
  const s = saved(kv);
  s.poll.retryAt = "2036-01-01T00:00:00.000Z";
  kv.data.set(KEY, JSON.stringify(s));
  w.queries.length = 0;
  await run(env(kv), at(8), f);
  assert.equal(w.queries.length, 1);
  // A plain 401 is an auth error, with no back-off.
  w.override.set(GRAPHQL, () => new Response("bad token", { status: 401 }));
  const r5 = await run(env(kv), at(9), f);
  assert.deepEqual([r5.state.poll.error?.kind, r5.state.poll.retryAt], ["auth", undefined]);
});

test("watcher: a follow-up that's rate limited keeps the back-off, and the repositories it was for keep their state", async () => {
  const { kv, w, f } = await started();
  w.repos.wordcraft!.unshift(release("wordcraft", "1.1.0"));
  w.hook = (q) => (q.includes(`tagName: "v1.1.0"`) ? new Response("slow", { status: 429, headers: { "retry-after": "1200" } }) : null);
  const r = await run(env(kv), at(1), f);
  assert.deepEqual([r.state.repos.wordcraft.eligible?.version, r.state.repos.wordcraft.error?.kind, r.state.poll.retryAt, r.written],
    ["1.0.0", "rate-limit", at(21).toISOString(), true]);
  assert.equal(r.state.repos.deckcraft.error, undefined);
});

test("watcher: back-off: one following on from a saved one lasts twice as long, and a day of rate limits stays in the write budget", async () => {
  const { kv, w, f } = await started();
  const asks: number[] = [];
  let m = 0;
  w.override.set(GRAPHQL, () => { asks.push(m); return new Response("slow", { status: 429, headers: { "retry-after": "120" } }); });
  const first = kv.writes;
  const day = 24 * 60;
  for (m = 1; m <= day; m++) await run(env(kv), at(m), f);
  // Asked at 1, then 2, 4, 8, 16, 32 minutes later, then hourly.
  assert.deepEqual(asks.slice(0, 7), [1, 3, 7, 15, 31, 63, 123]);
  assert.ok(asks.length <= 6 + day / 60, `${asks.length} asks`);
  const writes = kv.writes - first;
  assert.ok(writes <= 150, `${writes} writes in a day of rate limits`);
  assert.equal(saved(kv).poll.retryMs, MAX_BACKOFF_MS);
  // It ends: the next ask succeeds and the back-off is gone.
  w.override.delete(GRAPHQL);
  const r = await run(env(kv), at(asks.at(-1)! + 60), f);
  assert.deepEqual([r.state.poll.retryAt, r.state.poll.retryMs, r.state.poll.error], [undefined, undefined, undefined]);
});

test("watcher: deployment health: a new version counts as healthy only once its sweep read GitHub", async () => {
  const { kv, w, f } = await started();
  assert.equal(saved(kv).polledBy, "v1");
  const v2 = (kv: FakeKV): Env => ({ ...env(kv), CF_VERSION: { id: "v2" } });
  w.override.set(GRAPHQL, () => new Response("down", { status: 502 }));
  const r1 = await run(v2(kv), at(1), f);
  assert.deepEqual([r1.written, saved(kv).deployed, saved(kv).polledBy], [true, "v2", "v1"], "written by v2, but its poll failed");
  // A follow-up failing isn't a good poll either.
  w.override.delete(GRAPHQL);
  w.repos.photocraft!.unshift(release("photocraft", "1.1.0"));
  w.hook = (q) => (q.includes(`tagName: "v1.1.0"`) && !q.includes("main:versions") ? new Response("down", { status: 502 }) : null);
  await run(v2(kv), at(2), f);
  assert.equal(saved(kv).polledBy, "v1");
  w.hook = null;
  const r3 = await run(v2(kv), at(3), f);
  assert.deepEqual([r3.written, saved(kv).polledBy], [true, "v2"]);
  // What the deploy workflow waits for.
  const body: any = await (await health(new Request("https://w/health", { headers: { authorization: "Bearer h" } }), v2(kv))).json();
  assert.deepEqual([body.deployed, body.state.deployed, body.state.polledBy], ["v2", "v2", "v2"]);
  // A sweep skipped by a back-off doesn't count.
  const kv3 = new FakeKV();
  await run(env(kv3), at(1), f);
  w.override.set(GRAPHQL, () => new Response("slow", { status: 429, headers: { "retry-after": "1800" } }));
  await run(env(kv3), at(2), f);
  w.override.delete(GRAPHQL);
  await run(v2(kv3), at(3), f);
  assert.deepEqual([saved(kv3).deployed, saved(kv3).polledBy], ["v2", "v1"]);
});

test("watcher: the dispatch asks for main, is retried, and backs off", async () => {
  const { kv, w, f } = await started();
  w.repos.cadcraft!.unshift(release("cadcraft", "1.1.0"));
  w.override.set(DISPATCH, () => new Response("down", { status: 502 }));
  const r1 = await run(env(kv), at(1), f);
  assert.deepEqual([r1.dispatched, r1.state.dispatch.pending, r1.state.dispatch.error?.kind, r1.written], [false, true, "http", true]);
  w.override.delete(DISPATCH);
  const r2 = await run(env(kv), at(2), f);
  assert.deepEqual([r2.dispatched, r2.state.dispatch, w.dispatches], [true, { pending: false }, [{ ref: "main" }]]);
  // A long back-off is saved at once, and the dispatch isn't asked again during it.
  let asked = 0;
  w.override.set(DISPATCH, () => { asked++; return new Response("slow", { status: 429, headers: { "retry-after": "900" } }); });
  w.repos.cadcraft!.unshift(release("cadcraft", "1.2.0"));
  const r3 = await run(env(kv), at(3), f);
  assert.deepEqual([r3.state.dispatch.retryAt, asked], [at(18).toISOString(), 1]);
  await run(env(kv), at(4), f);
  assert.deepEqual([asked, saved(kv).dispatch.pending], [1, true]);
});

test("watcher: the KV write budget: a quiet day is the heartbeats; errors coming and going cost nothing more; a change costs one", async () => {
  const { kv, w, f } = await started();
  const first = kv.writes;
  const day = 24 * 60;
  for (let m = 1; m <= day; m++) await run(env(kv), at(m), f);
  assert.equal(kv.writes - first, day / (HEARTBEAT_MS / 60_000));
  // The query failing every other minute, and a repository going missing by turns.
  let m = day;
  w.hook = () => (m % 2 ? new Response("down", { status: 500 }) : null);
  const before = kv.writes;
  for (m = day + 1; m <= 2 * day; m++) {
    w.repos.soundcraft = m % 3 ? [release("soundcraft", "1.0.0")] : null;
    await run(env(kv), at(m), f);
  }
  assert.equal(kv.writes - before, day / (HEARTBEAT_MS / 60_000));
  w.hook = null;
  w.repos.soundcraft = [release("soundcraft", "1.0.0")];
  await run(env(kv), at(2 * day + 1), f);
  const quiet = kv.writes;
  w.repos.photocraft!.unshift(release("photocraft", "1.1.0"));
  await run(env(kv), at(2 * day + 2), f);
  assert.equal(kv.writes, quiet + 1, "one write for the change and its dispatch");
});

test("watcher: while KV writes fail, polling and dispatching go on, one dispatch a minute", async () => {
  const { kv, w, f } = await started();
  kv.failWrites = true;
  w.repos.deckcraft!.unshift(release("deckcraft", "1.1.0"));
  for (let m = 1; m <= 5; m++) {
    const r = await run(env(kv), at(m), f);
    assert.deepEqual([r.written, r.dispatched], [false, true]);
  }
  assert.equal(w.dispatches.length, 5);
  kv.failWrites = false;
  assert.equal((await run(env(kv), at(6), f)).written, true);
  assert.equal(saved(kv).repos.deckcraft.eligible?.version, "1.1.0");
  assert.equal((await run(env(kv), at(7), f)).dispatched, false);
  assert.equal(w.dispatches.length, 6);
});

test("watcher: while KV reads fail, it polls and dispatches every minute and never writes", async () => {
  const { kv, w, f } = await started();
  const good = kv.data.get(KEY);
  kv.failReads = true;
  for (let m = 1; m <= 3; m++) {
    const r = await run(env(kv), at(m), f);
    assert.deepEqual([r.written, r.dispatched, eligible(r.state).photocraft], [false, true, "1.0.0"]);
  }
  assert.equal(w.dispatches.length, 3, "one a minute");
  assert.equal(kv.data.get(KEY), good, "the saved state is untouched");
  kv.failReads = false;
  const r = await run(env(kv), at(4), f);
  assert.deepEqual([r.dispatched, r.state.repos.photocraft.eligible?.firstSeen], [false, t0.toISOString()]);
});

test("watcher: a stored state of the wrong shape starts over", async () => {
  const kv = new FakeKV();
  kv.data.set(KEY, `{"repos":{}}`);
  const { f } = world();
  const r = await run(env(kv), t0, f);
  assert.equal(r.state.repos.photocraft.eligible?.version, "1.0.0");
});

test("health: 404 without the token, and no KV read", async () => {
  const kv = new FakeKV();
  for (const auth of [undefined, "Bearer wrong", "Bearer hh", "bearer h", "h"]) {
    const res = await health(new Request("https://w/health", { headers: auth ? { authorization: auth } : {} }), env(kv));
    assert.equal(res.status, 404);
  }
  assert.equal((await health(new Request("https://w/other", { headers: { authorization: "Bearer h" } }), env(kv))).status, 404);
  assert.equal((await health(new Request("https://w/health", { method: "POST", headers: { authorization: "Bearer h" } }), env(kv))).status, 404);
  const blank = { ...env(kv), HEALTH_TOKEN: "" };
  assert.equal((await health(new Request("https://w/health", { headers: { authorization: "Bearer " } }), blank)).status, 404);
  assert.equal(kv.reads, 0);
  const { f } = world();
  await run(env(kv), t0, f);
  const res = await health(new Request("https://w/health", { headers: { authorization: "Bearer h" } }), env(kv));
  const body: any = await res.json();
  assert.deepEqual([res.status, body.deployed, body.state.deployed, body.state.repos.photocraft.eligible.version], [200, "v1", "v1", "1.0.0"]);
  kv.failReads = true;
  assert.equal((await health(new Request("https://w/health", { headers: { authorization: "Bearer h" } }), env(kv))).status, 503);
});

test("health: the backstop's reading keeps KV write health apart from each repository's freshness", async () => {
  const { kv, w, f } = await started();
  w.repos.gridcraft = null;
  w.override.set(DISPATCH, () => new Response("no", { status: 401 }));
  w.repos.photocraft!.unshift(release("photocraft", "1.1.0"));
  for (let m = 1; m <= 45; m++) await run(env(kv), at(m), f);
  const body = await (await health(new Request("https://w/health", { headers: { authorization: "Bearer h" } }), env(kv))).json();
  const h = readHealth(body, at(46))!;
  assert.equal(h.writesStale, false);
  assert.deepEqual([h.repos.gridcraft.stale, h.repos.gridcraft.error?.kind, h.repos.photocraft.stale], [true, "not-found", false]);
  assert.deepEqual([h.auth.length, h.auth[0].startsWith("dispatch:"), h.stuck], [1, true, []]);
  assert.equal(readHealth(body, new Date(at(45).getTime() + STUCK_MS + 60_000))!.stuck.includes("gridcraft"), true);
  // Writes failing: the heartbeat goes stale, whatever the repositories say.
  const later = readHealth(body, new Date(Date.parse(h.written!) + STALE_MS + 60_000))!;
  assert.equal(later.writesStale, true);
  assert.equal(readHealth({ deployed: "v1", state: null }, t0), null);
  assert.equal(readHealth("nonsense", t0), null);
});

test("watcher: a deleted pin whose first lower release is incomplete: paging goes on to the eligible fallback", async () => {
  const { kv, w, f } = await started();
  const p = "effectcraft";
  // The pin (1.0.0) is deleted. Page one: filler and 0.9.5 (published but
  // incomplete); page two: 0.9.0, eligible.
  const filler = Array.from({ length: RECENT - 1 }, (_, i) => ({ tag: `ci-${i}`, assets: {} }) as FakeRelease);
  w.repos[p] = [...filler, incomplete(p, "0.9.5"), release(p, "0.9.0")];
  let r = await run(env(kv), at(1), f);
  for (let k = 2; k < 6 && r.state.repos[p].eligible?.version !== "0.9.0"; k++) r = await run(env(kv), at(k), f);
  assert.equal(r.state.repos[p].eligible?.version, "0.9.0");
  assert.equal(r.state.repos[p].error, undefined);
});
