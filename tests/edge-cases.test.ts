// Edge cases found by an adversarial pass: backports ahead of an upgrade,
// huge version and release numbers, a dry-run Latest repair, and a re-run
// health check reading old pins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requiredNames, select, sourceOf } from "../shared/sources.ts";
import { assess } from "../scripts/ci/health.ts";
import { currentPin } from "../scripts/lib/util.ts";
import { io } from "../scripts/update.ts";
import { allocate } from "../scripts/lib/releases.ts";
import { DryRun } from "../scripts/ci/gh.ts";
import { reconcile } from "../scripts/ci/reconcile.ts";
import { Fake } from "./fake-gh.ts";

const source = sourceOf("photocraft");
function release(version: string) {
  return {
    tag_name: "v" + version, draft: false, prerelease: false,
    assets: requiredNames(source, version).map((name, id) => ({
      name, id, digest: "sha256:" + "a".repeat(64), state: "uploaded", size: 1,
    })),
  };
}

test("a wave of backports does not hide an upgrade created after the pin", async (t) => {
  const pages = [
    Array.from({ length: 30 }, (_, i) => release("1.0." + (30 - i))),
    [release("2.1.0"), release("2.0.0")],
  ];
  t.mock.method(globalThis, "fetch", async (url: URL) =>
    Response.json(pages[Number(url.searchParams.get("page")) - 1]));
  const result = await io.releases(source, "v2.0.0");
  assert.equal(result.complete, true);
  assert.equal(select(source, result.items).candidate?.tag, "v2.1.0");
});

test("a valid release keeps its exact decimal version when matching asset names", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([release("1.0.9007199254740993")]));
  const result = await io.releases(source, null);
  assert.equal(select(source, result.items).candidate?.tag, "v1.0.9007199254740993");
});

test("release allocation advances beyond an existing decimal suffix", () => {
  assert.equal(allocate(["2026.11.22.9007199254740992"], new Date("2026-11-22T00:00:00Z")),
    "2026.11.22.9007199254740993");
});

test("dry reconciliation models a successful Latest repair", async () => {
  const reader = new Fake();
  const name = "2026.11.22.1";
  const sha = "a".repeat(40);
  reader.refMap["refs/tags/" + name] = sha;
  reader.releaseList.push({ id: 1, tag: name, name, target: sha, body: "" });
  reader.releaseList.unshift({ id: 2, tag: "older", name: "older", target: "b".repeat(40), body: "" });
  reader.marked = "older";
  const dry = new DryRun(reader);
  const notes = await reconcile(dry, "main", [{ sha, trailer: name }], () => "");
  assert.ok(dry.actions.some((a) => a.action === "mark_latest"));
  assert.deepEqual(notes.filter((o) => o.kind.startsWith("latest-")).map((o) => o.kind), ["latest-match"]);
});

test("reading an old checkout during a health rerun falsely reports lag on a current main", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const pin = currentPin(source.repo)!;
  const body = { state: {
    written: now.toISOString(), poll: {}, dispatch: {}, pins: {},
    repos: { [source.repo]: { read: now.toISOString(), eligible: {
      version: pin.version, firstSeen: "2026-11-22T09:00:00Z",
    } } },
  } };
  const lag = (version: string) => assess(body, null, { [source.repo]: { ...pin, version } }, new Set(), now)
    .filter((o) => o.repo === source.repo).map((o) => o.kind);
  assert.deepEqual(lag(pin.version), ["lag-ok"]);
  // The same live reply, with the checkout version from the run being retried.
  const workflow = readFileSync(new URL("../.github/workflows/health.yml", import.meta.url), "utf8");
  const checkout = workflow.split("uses: actions/checkout@")[1].split("      - uses:")[0];
  const checkedOutVersion = /^\s*ref:\s*main\s*$/m.test(checkout) ? pin.version : "0.0.1";
  assert.deepEqual(lag(checkedOutVersion), ["lag-ok"]);
});

test("pages that never reach the pin: a pin that's gone (404 by tag) lets a lower release stand in; one that exists leaves the list incomplete", async (t) => {
  const page = (p: number) => Array.from({ length: 30 }, (_, i) => release(`1.${p}.${30 - i}`));
  for (const [byTag, complete] of [[404, true], [200, false]] as const) {
    t.mock.method(globalThis, "fetch", async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/releases/tags/v2.0.0")) return byTag === 404 ? new Response("{}", { status: 404 }) : Response.json(release("2.0.0"));
      return Response.json(page(Number(u.searchParams.get("page"))));
    });
    const r = await io.releases(source, "v2.0.0");
    assert.equal(r.complete, complete, `by tag ${byTag}`);
    t.mock.restoreAll();
  }
});

test("exactly three full pages and nothing after: the list is complete", async (t) => {
  const page = (p: number) => Array.from({ length: 30 }, (_, i) => release(`1.${p}.${30 - i}`));
  t.mock.method(globalThis, "fetch", async (url: URL | string) => {
    const u = new URL(String(url));
    if (u.searchParams.get("per_page") === "1") return Response.json([]);
    return Response.json(page(Number(u.searchParams.get("page"))));
  });
  // A pin the list never reaches: all three pages read, then nothing more.
  const r = await io.releases(source, "v2.0.0");
  assert.equal(r.complete, true);
  assert.equal(r.items.length, 90);
});

test("a pulled pin: the whole window is read, then any eligible release below it stands in", async () => {
  const { farEnough, fromRest } = await import("../shared/sources.ts");
  const pulled = { ...release("2.0.0"), prerelease: true };
  const rc = { ...release("1.9.0-rc.1"), prerelease: true };
  // Before the window's end, nothing below the pin settles it: the release
  // main was on may be further down.
  assert.equal(farEnough(source, [release("1.8.5"), pulled, rc].map(fromRest), "v2.0.0"), false);
  assert.equal(farEnough(source, [pulled, release("1.9.0")].map(fromRest), "v2.0.0"), false);
  // At the end, a backport created since the pin does, as does one after it.
  assert.equal(farEnough(source, [release("1.8.5"), pulled].map(fromRest), "v2.0.0", true, false, true), true);
  assert.equal(farEnough(source, [pulled, release("1.9.0")].map(fromRest), "v2.0.0", true, false, true), true);
  // Nothing eligible besides it: no. One above it: yes.
  assert.equal(farEnough(source, [pulled, rc].map(fromRest), "v2.0.0", true, false, true), false);
  assert.equal(farEnough(source, [release("2.1.0"), pulled, rc].map(fromRest), "v2.0.0", true, false, true), true);
  // Not reached and not gone: a lower release alone doesn't do, even at the end.
  assert.equal(farEnough(source, [release("1.9.0")].map(fromRest), "v2.0.0", true, false, true), false);
});

/** Pages of 30 from one list, newest first, as the REST API serves them;
 * a release by tag from the same list. Returns the URLs asked for. */
function serve(t: any, all: any[]) {
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL | string) => {
    const u = new URL(String(url));
    asked.push(u.pathname + u.search);
    if (u.pathname.includes("/releases/tags/")) {
      const r = all.find((x) => x.tag_name === decodeURIComponent(u.pathname.split("/releases/tags/")[1]));
      return r ? Response.json(r) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const per = Number(u.searchParams.get("per_page")), page = Number(u.searchParams.get("page"));
    return Response.json(all.slice((page - 1) * per, page * per));
  });
  return asked;
}

test("a pulled pin a page boundary away from the release before it: the fallback is the highest in the window, not the backport", async (t) => {
  // 1.8.5 (a backport) first; the pin at 29, a prerelease at 30; 1.9.0 at 31.
  const all = [release("1.8.5"), ...Array.from({ length: 27 }, (_, i) => ({ ...release(`3.0.${i}`), prerelease: true })),
    { ...release("2.0.0"), prerelease: true }, { ...release("1.9.0-rc.1"), prerelease: true }, release("1.9.0"), release("1.7.0")];
  try {
    serve(t, all);
    const r = await io.releases(source, "v2.0.0");
    assert.equal(r.complete, true);
    assert.equal(select(source, r.items).candidate?.tag, "v1.9.0");
  } finally {
    t.mock.restoreAll();
  }
});

test("a pulled pin at the window's last item: the backport stands in, no stall", async (t) => {
  // The pin is item 90; the release before it (1.9.0) is item 91, past the window.
  const all = [release("1.8.5"), ...Array.from({ length: 88 }, (_, i) => ({ ...release(`3.0.${i}`), prerelease: true })),
    { ...release("2.0.0"), prerelease: true }, release("1.9.0")];
  try {
    serve(t, all);
    const r = await io.releases(source, "v2.0.0");
    assert.equal(r.complete, true);
    assert.equal(r.items.length, 90);
    assert.equal(select(source, r.items).candidate?.tag, "v1.8.5");
  } finally {
    t.mock.restoreAll();
  }
});

test("a pulled pin listed in a full window with an eligible release: complete, without asking what comes after", async (t) => {
  const all = [release("1.8.5"), ...Array.from({ length: 88 }, (_, i) => ({ ...release(`3.0.${i}`), prerelease: true })),
    { ...release("2.0.0"), prerelease: true }, release("1.9.0")];
  try {
    const asked = serve(t, all);
    const r = await io.releases(source, "v2.0.0");
    assert.equal(r.complete, true);
    assert.ok(!asked.some((a) => a.includes("per_page=1&")), "no probe past the window");
  } finally {
    t.mock.restoreAll();
  }
});

test("a pin past the window, a prerelease again by tag: a release in the window stands in", async (t) => {
  const all = [release("2.1.0"), ...Array.from({ length: 89 }, (_, i) => ({ ...release(`2.0.1-rc.${i}`), prerelease: true })),
    { ...release("2.0.0"), prerelease: true }, release("1.9.0")];
  try {
    serve(t, all);
    const r = await io.releases(source, "v2.0.0");
    assert.equal(r.complete, true);
    assert.equal(select(source, r.items).candidate?.tag, "v2.1.0");
    // Still published by tag: unknown, as before.
    all[90] = release("2.0.0");
    assert.equal((await io.releases(source, "v2.0.0")).complete, false);
  } finally {
    t.mock.restoreAll();
  }
});
