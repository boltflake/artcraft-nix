// The status page's HTML, styles and script (scripts/status-page.ts), from
// hand-made rows; the script runs in node:vm against a small stub DOM. The
// script's and the bolt's tests are t3code-nix's, whose script this is.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { html, minifyCss, minifyJs, SCRIPT, SCRIPT_HASH, STYLE, utc, type DemoInfo } from "../scripts/status-page.ts";
import type { Delivery, DeliveryFigure, Row, StableView } from "../scripts/status.ts";
import type { Live, PinState } from "../scripts/status-live.ts";

const pub = (at: string, release: string | null = "2026.11.13.1") => ({ at, commit: "c".repeat(40), release });
const exactAt = (at: string) => ({ at, kind: "published" as const });
const d = (gap: number | null, kind: "published" | "seen" | null = "published", version = "1"): Delivery =>
  ({ version, published: pub("2026-11-10T00:00:00.000Z"), released: kind ? { at: "2026-11-09T23:00:00.000Z", kind } : null, gap });
/** A row: delivered 8 minutes after an exact release, with a short history. */
function row(name: string, extra: Partial<Row> = {}): Row {
  return { name, repo: name.replace(/-(cli|server|studio)$/, "").replace(/^artcraft$/, "artcraft"), version: "1.0", released: exactAt("2026-11-13T11:52:00.000Z"),
    published: pub("2026-11-13T12:00:00.000Z"), gap: 480, notes: null, counted: true, history: [d(480), d(3 * 3600), d(9 * 3600)], unavailable: null, ...extra };
}
const live = (states: Record<string, PinState>, checked = "2026-11-13T11:50:00.000Z"): Live => ({ checked, states });
const text = (h: string) => h.replace(/<wbr>/g, "").replace(/&#39;/g, "'").replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The markup of one package's row. */
const rowOf = (page: string, name: string) => page.slice(page.indexOf(`id="pkg-${name}"`), page.indexOf("</li>\n", page.indexOf(`id="pkg-${name}"`)));
const ok: PinState = { state: "current" };
const fig = (target: number | null, all: number | null): DeliveryFigure => ({ since: "2026-10-14T12:00:00.000Z", until: "2026-11-13T12:00:00.000Z",
  target: target === null ? null : { median: target, count: 9 }, all: all === null ? null : { median: all, count: 12 } });
const stableOk: StableView = { channel: "nixos-26.05", current: true, differing: [], unavailable: [], issue: null, broken: null, builds: null };

test("page: nothing loaded from anywhere, the policy, the title and the mark", () => {
  const page = html([row("photocraft", { notes: "https://github.com/storytold/photocraft/releases/tag/v1.0" })], "o/r", live({ photocraft: ok }), "id1");
  const urls = [...page.matchAll(/(?:https?:)?\/\/[^\s"'<>)]+/g)].map((m) => m.index!);
  assert.ok(urls.length > 0);
  for (const at of urls) assert.match(page.slice(Math.max(0, at - 6), at), /href="$/, `a URL outside an href: ${page.slice(at, at + 60)}`);
  assert.ok(!/\bsrc=|url\((?!#(?:hatch|mark-blur)\))|@import|<link\b|<img\b|<iframe\b/i.test(page), "nothing loaded");
  assert.ok(page.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'"`));
  assert.equal(SCRIPT_HASH, `sha256-${createHash("sha256").update(page.match(/<script>([\s\S]*?)<\/script>/)![1]).digest("base64")}`);
  assert.equal(SCRIPT.split("fetch(").length, 2, "one fetch, of the site's own live.json");
  assert.ok(SCRIPT.includes(`fetch("live.json?t=" + Date.now()`));
  assert.ok(page.includes("<title>Package status · artcraft-nix</title>"));
  assert.match(page, /<div class="title"><a class="brand" href="https:\/\/github\.com\/o\/r"><svg class="mark"[^]*?<span>artcraft-nix<\/span><\/a><div class="crumb"><span class="slash" aria-hidden="true">\/<\/span><h1>Package status<\/h1>/);
  assert.ok(page.includes(`<style>${minifyCss(STYLE)}</style>`), "the style, minified");
  assert.equal(page.split('id="mark-blur"').length, 2, "the glow's filter, once");
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(text(page)), "no raw ISO times in the text");
  assert.ok(page.includes('data-id="id1"') && !page.includes("data-demo"));
  for (const href of ["https://github.com/o/r#quick-start", "https://github.com/o/r/releases", "https://github.com/o/r"]) assert.ok(page.includes(`href="${href}"`), href);
  assert.ok(page.includes('Last checked against upstream: <time id="checked-exact" datetime="2026-11-13T11:50:00.000Z">13 Nov 2026, 11:50 UTC</time>.'));
  assert.ok(page.includes('<a class="hit" href="https://github.com/storytold/photocraft/releases/tag/v1.0">1.<wbr>0<span class="sr">, release notes for PhotoCraft</span></a>'));
  assert.ok(!page.includes('class="demo"') && !page.includes('class="tag sample"'), "no demo banner or sample tags in a real build");
});

test("page: the style and script, minified without changing a rule or a statement", () => {
  const css = minifyCss(STYLE);
  assert.ok(css.length < STYLE.length * 0.8, "smaller");
  assert.ok(!css.includes("/*") && !/\n/.test(css), "no comments, no line breaks");
  assert.deepEqual([...new Set(STYLE.match(/"[^"]*"/g))].sort(), ['""', '"Helvetica Neue"', '"Liberation Mono"', '"Segoe UI"']);
  assert.ok(!STYLE.includes("\\"), "no escapes");
  assert.ok(!STYLE.replace(/\/\*[\s\S]*?\*\//g, "").includes("'"), "no single-quoted strings");
  const squeeze = (t: string) => t.replace(/\s+/g, " ").replace(/\s*([,>])\s*/g, "$1").replace(/:\s+/g, ":").trim();
  const bare = STYLE.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{};]+)\{/g)) assert.ok(css.includes(squeeze(m[1]) + "{"), `selector: ${m[1].trim()}`);
  for (const m of bare.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/g)) assert.ok(css.includes(`${m[1]}:${squeeze(m[2])}`), `declaration: ${m[0].trim()}`);
  assert.equal(minifyJs("  const a = 1; // kept\n\n  // dropped\n  f();\n"), "const a = 1; // kept\nf();");
  assert.ok(!/^\s|^\/\/|\s$/m.test(SCRIPT), "no indentation, comment lines or trailing space");
  assert.ok(!SCRIPT.includes("`"), "no template strings, so none spans lines");
  assert.ok(!/\\$/m.test(SCRIPT));
  for (const line of SCRIPT.split("\n")) assert.ok(!/["'][^"']*\/\/[^"']*["']/.test(line), `no "//" in a string: ${line}`);
});

test("page: every title's text is also on the page, and each strip bar is in its details", () => {
  const dv = (version: string, at: string, gap: number): Delivery => ({ ...d(gap, "published", version), published: pub(at) });
  const page = html([
    row("photocraft", { history: [dv("1.0", "2026-11-13T12:00:00.000Z", 480), dv("0.9", "2026-11-12T08:30:00.000Z", 3 * 3600), dv("0.8", "2026-11-10T17:05:00.000Z", 9 * 3600)] }),
    row("vectorcraft", { history: [dv("2.1", "2026-11-11T06:00:00.000Z", 600), dv("2.0", "2026-11-09T22:40:00.000Z", 7200)] }),
  ], "o/r", live({ photocraft: { state: "testing", version: "1.1", since: "2026-11-13T11:56:00.000Z", link: "https://github.com/o/r/actions/runs/9" }, vectorcraft: ok }), "x", stableOk, fig(412, 600));
  const body = page.slice(page.indexOf("<body>"), page.indexOf("<script>")).replace(/(<time class="rel"[^>]*>)[^<]*(<\/time>)/g, "$1$2");
  const visible = text(body.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<span class="sr">[^<]*<\/span>/g, " ").replace(/<(\w+)[^>]* hidden>[\s\S]*?<\/\1>/g, " "));
  const titles = [...body.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 2);
  for (const t of titles) assert.ok(visible.includes(t), `only in a title: ${t}`);
  let tips = 0;
  for (const li of body.split(/<li class="pkg/).slice(1)) {
    const strip = li.match(/<svg class="strip"[\s\S]*?<\/svg>/)?.[0] ?? "";
    const bars = [...strip.matchAll(/<g aria-hidden="true" data-v="([^"]*)" data-d="([^"]*)" data-note="([^"]*)" data-band="(\w+)" data-at="([^"]+)"><rect class="hit"/g)];
    const hist = [...li.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1].replace(/<wbr>/g, "")).trim());
    for (const [, v, took, , , at] of bars) {
      assert.ok(hist.some((h) => h.startsWith(`${v} ${took} ${utc(at)}`)), `only in a card: ${v} ${took}`);
      tips++;
    }
  }
  assert.equal(tips, 5);
});

test("page: groups in SOURCES' order, companions under their apps, Studio on its own, NixOS stable last", () => {
  const names = ["artcraft-studio", "figcraft-server", "pdfcraft-cli", "figcraft", "photocraft", "pdfcraft", "newcomer"];
  const page = html(names.map((n) => row(n)), "o/r", live({}), "x", stableOk);
  const at = (n: string) => page.indexOf(`id="pkg-${n}"`);
  for (const [a, b] of [["photocraft", "pdfcraft"], ["pdfcraft", "pdfcraft-cli"], ["pdfcraft-cli", "figcraft"], ["figcraft", "figcraft-server"], ["figcraft-server", "newcomer"]]) {
    assert.ok(at(a) < at(b), `${a} before ${b}`);
  }
  assert.ok(page.indexOf('id="apps"') < at("photocraft") && at("newcomer") < page.indexOf('id="studio"') && page.indexOf('id="studio"') < at("artcraft-studio"));
  assert.ok(at("artcraft-studio") < page.indexOf('id="nixos-stable"'));
  assert.match(page, /<h2 id="apps">Craft Apps <span class="count">4<\/span><\/h2>/, "companions aren't counted as apps");
  assert.ok(page.includes('<li class="pkg sub-pkg" id="pkg-pdfcraft-cli"') && page.includes('<li class="pkg" id="pkg-pdfcraft"'));
  assert.ok(rowOf(page, "pdfcraft-cli").includes('<h3 class="pkg-name">PdfCraft CLI</h3> <code class="attr">pdfcraft-cli</code>'));
  assert.ok(rowOf(page, "photocraft").includes('<p class="desc">Edit photos and layered PSD documents</p>'));
  assert.ok(page.includes('<span class="col-ver">On <code>main</code></span>'));
  assert.ok(page.includes('<p class="card-note stable-snapshot"><strong>Snapshot (<code>nixos-26.05</code>):</strong> current, the same pins as main.</p>'));
  assert.ok(!page.includes("stable-builds"), "builds not known without the live reads: not said");
});

test("page: the headline card, with and without the live view", () => {
  const list = ["photocraft", "vectorcraft", "figcraft", "figcraft-server", "materialcraft", "cadcraft"].map((n) => row(n));
  const plain = html(list, "o/r", null, "x");
  assert.ok(plain.includes('<h2 id="headline">6 packages</h2>') && plain.includes("Upstream status isn't available"));
  assert.ok(!plain.includes('class="cell state'), "no state column");
  const all = html(list, "o/r", live(Object.fromEntries(list.map((r) => [r.name, ok]))), "x");
  assert.ok(all.includes("All 6 packages up to date") && all.includes('aria-label="All up to date"'));
  const mixed = html(list, "o/r", live({
    photocraft: { state: "testing", version: "2" }, vectorcraft: { state: "found", version: "2" }, figcraft: { state: "held", version: "2", reason: "tests failed" },
    "figcraft-server": { state: "unavailable", version: "1.0", reason: "gone" }, materialcraft: { state: "waiting", version: "2", reason: "incomplete" },
  }), "x");
  assert.ok(mixed.includes("0 of 6 packages up to date"));
  assert.ok(mixed.includes('aria-label="Packages unavailable"'), "unavailable leads");
  const counts = text(mixed.match(/<p class="counts">[\s\S]*?<\/p>/)![0]).trim();
  assert.equal(counts, "1 unavailable · 1 held · 1 testing · 1 waiting for upstream · 1 new version found · 1 not checked");
});

test("page: the latest release, and a hand commit's latest update", () => {
  const list = [row("photocraft", { version: "0.23.1", published: pub("2026-11-13T12:00:00.000Z", "2026.11.13.4") }),
    row("pdfcraft", { version: "0.21.1", published: pub("2026-11-13T12:00:00.000Z", "2026.11.13.4") }), row("pdfcraft-cli", { version: "0.21.1", published: pub("2026-11-13T12:00:00.000Z", "2026.11.13.4") }),
    row("figcraft", { published: { at: "2026-11-12T00:00:00.000Z", commit: "d".repeat(40), release: null } })];
  const page = html(list, "o/r", null, "x");
  assert.ok(page.includes('Latest release <a class="hit" href="https://github.com/o/r/releases/tag/2026.11.13.4">2026.11.13.4<span class="sr">, the latest release</span></a>: <strong>PhotoCraft</strong> 0.<wbr>23.<wbr>1 and <strong>PdfCraft</strong> 0.<wbr>21.<wbr>1 · '),
    "the companion goes with its app");
  const hand = html([row("figcraft", { published: { at: "2026-11-12T00:00:00.000Z", commit: "d".repeat(40), release: null } })], "o/r", null, "x");
  assert.ok(hand.includes('<p class="latest">Latest update: <strong>FigCraft</strong> 1.<wbr>0 · '));
});

test("page: needs attention and updates underway, a companion sharing its app's state listed with it", () => {
  const held: PinState = { state: "held", version: "0.18.2", reason: "tests failed", since: "2026-11-13T09:00:00.000Z", link: "https://github.com/o/r/issues/41" };
  const page = html(["photocraft", "pdfcraft", "pdfcraft-cli", "figcraft", "figcraft-server", "materialcraft", "vectorcraft"].map((n) => row(n)), "o/r", live({
    photocraft: { state: "testing", version: "0.23.2", since: "2026-11-13T11:52:00.000Z", link: "https://github.com/o/r/actions/runs/7" },
    pdfcraft: held, "pdfcraft-cli": held,
    figcraft: ok, "figcraft-server": { state: "unavailable", version: "0.18.1", reason: "upstream's files are gone", since: "2026-11-12T08:00:00.000Z", link: "https://github.com/o/r/issues/40" },
    materialcraft: { state: "waiting", version: "0.4.2", reason: "upstream's release is incomplete", link: "https://github.com/o/r/issues/43" },
    vectorcraft: { state: "found", version: "0.24.2", wait: "queued for next run", since: "2026-11-13T11:58:00.000Z", link: "https://github.com/storytold/vectorcraft/releases/tag/v0.24.2" },
  }), "x");
  const attention = text(page.match(/<section class="notice attention"[\s\S]*?<\/section>/)![0]);
  assert.match(attention, /Needs attention FigCraft server : 0\.18\.1: upstream's files are gone · since 12 Nov 2026, 08:00 UTC · View issue for FigCraft server PdfCraft \(with PdfCraft CLI\): 0\.18\.2: tests failed · found 13 Nov 2026, 09:00 UTC · View issue/);
  const underway = text(page.match(/<section class="notice underway"[\s\S]*?<\/section>/)![0]);
  assert.match(underway, /PhotoCraft : testing 0\.23\.2 .*MaterialCraft : 0\.4\.2: upstream's release is incomplete · View issue .*VectorCraft : 0\.24\.2 found · found .* · queued for next run · Release notes/);
  // In the rows.
  assert.ok(rowOf(page, "photocraft").includes('<a class="hit" href="https://github.com/o/r/actions/runs/7">Testing 0.<wbr>23.<wbr>2<span class="sr"> for PhotoCraft</span></a>'));
  assert.ok(rowOf(page, "figcraft-server").includes('class="cell state gone"') && rowOf(page, "figcraft-server").includes(">Unavailable<"));
  assert.ok(rowOf(page, "materialcraft").includes('class="cell state wait"') && rowOf(page, "materialcraft").includes("Waiting for 0.<wbr>4.<wbr>2"));
  assert.ok(rowOf(page, "pdfcraft").includes("Held: tests failed"));
  assert.ok(rowOf(page, "vectorcraft").includes("New version 0.<wbr>24.<wbr>2") && rowOf(page, "vectorcraft").includes("queued for next run"));
});

test("page: an unavailable package says so in its details", () => {
  const page = html([row("figcraft-server", { unavailable: { since: "2026-11-12T08:00:00.000Z", issue: 40 } })], "o/r", null, "x");
  assert.match(rowOf(page, "figcraft-server"), /<dt>Unavailable<\/dt><dd>Upstream's files for 1\.0 are gone, since <time[^>]*>12 Nov 2026, 08:00 UTC<\/time>\./);
});

test("page: the delivery figure: the target, met or not, and the all-releases median", () => {
  const list = [row("photocraft")];
  const met = html(list, "o/r", null, "x", null, fig(406, 513));
  assert.ok(met.includes('<p class="figure-value">7 min</p>') && met.includes("Median delivery, last 30 days") && met.includes("within the 9 min target"));
  assert.ok(met.includes("All releases, queueing included: 9 min (12)."));
  const over = html(list, "o/r", null, "x", null, fig(600, 700));
  assert.ok(over.includes("over the 9 min target"));
  const onlyAll = html(list, "o/r", null, "x", null, fig(null, 700));
  assert.ok(onlyAll.includes('<p class="figure-value">12 min</p>') && onlyAll.includes("Median delivery over all releases") && !onlyAll.includes("target</span>"));
  assert.ok(!html(list, "o/r", null, "x", null, null).includes('class="figure"'));
});

test("page: NixOS stable, behind, broken, and per row", () => {
  const behind: StableView = { channel: "nixos-26.05", current: false, differing: [{ name: "lightcraft", stable: "0.21.0", main: "0.21.1" }, { name: "pdfcraft", stable: "0.21.1", main: "0.21.1" }],
    unavailable: ["figcraft-server"], issue: 44, broken: 45, builds: "broken" };
  const page = html([row("lightcraft", { version: "0.21.1" }), row("pdfcraft", { version: "0.21.1" }), row("figcraft-server")], "o/r", null, "x", behind);
  assert.ok(page.includes('<strong>Snapshot (<code>nixos-26.05</code>):</strong> behind main: LightCraft 0.21.0, main 0.21.1; PdfCraft 0.21.1, main a newer build of it. <a href="https://github.com/o/r/issues/44">Why (#44)</a> Unavailable there: FigCraft server.</p>'));
  assert.ok(page.includes(`<strong>Builds:</strong> failing on NixOS stable; the snapshot doesn't move until they pass. <a href="https://github.com/o/r/issues/45">Issue (#45)</a>`));
  assert.ok(rowOf(page, "lightcraft").includes('<span class="sub">stable 0.<wbr>21.<wbr>0</span>'));
  assert.ok(rowOf(page, "lightcraft").includes("<dt>NixOS stable</dt><dd>0.21.0, behind main</dd>"));
  assert.ok(!rowOf(page, "pdfcraft").includes('<span class="sub">stable'), "a newer build: no tag, said in the details");
  assert.ok(rowOf(page, "pdfcraft").includes("main a newer build of it"));
  assert.ok(rowOf(page, "figcraft-server").includes("The same as main, unavailable there"));
});

test("page: NixOS stable's snapshot and builds are told apart: current and failing, current and passing, a marker behind", () => {
  const list = [row("figcraft"), row("figcraft-server")];
  const both = html(list, "o/r", null, "x", { ...stableOk, broken: 9, builds: "broken" });
  assert.ok(both.includes("<strong>Snapshot (<code>nixos-26.05</code>):</strong> current, the same pins as main."), "an up-to-date snapshot");
  assert.ok(both.includes("<strong>Builds:</strong> failing on NixOS stable"), "and a broken build, at once");
  assert.ok(!both.includes("passing"));
  const fine = html(list, "o/r", null, "x", { ...stableOk, builds: "ok" });
  assert.ok(fine.includes("<strong>Builds:</strong> passing, no open stable failure."));
  const marker = html(list, "o/r", null, "x", { ...stableOk, current: false, builds: "ok",
    differing: [{ name: "figcraft-server", stable: "0.18.1", main: "0.18.1", marker: "main" }, { name: "figcraft", stable: "0.18.1", main: "0.18.1", marker: "stable" }] });
  assert.ok(marker.includes("behind main: FigCraft server 0.18.1 unavailable on main, not yet in the snapshot; FigCraft 0.18.1 available again on main, still unavailable in the snapshot."));
  assert.ok(rowOf(marker, "figcraft-server").includes("<dt>NixOS stable</dt><dd>0.18.1, the same files; main marks it unavailable, the snapshot not yet</dd>"));
  assert.ok(!rowOf(marker, "figcraft-server").includes('<span class="sub">stable'), "no version tag: the versions agree");
});

test("page: a pulled pin going back, and a same-tag re-upload under test or held", () => {
  const list = [row("photocraft", { version: "0.23.1" }), row("artcraft-studio", { version: "0.41.1" }), row("pdfcraft", { version: "0.21.1" })];
  const page = html(list, "o/r", live({
    photocraft: { state: "testing", version: "0.23.1", reason: "same version, new files", since: "2026-11-13T11:40:00.000Z", link: "https://github.com/o/r/actions/runs/8" },
    "artcraft-studio": { state: "pulled", version: "0.41.0", reason: "upstream pulled this release; main follows back after the tests", wait: "waiting for the next run",
      since: "2026-11-13T11:00:00.000Z", link: "https://github.com/storytold/artcraft/releases/tag/artcraft-v0.41.0" },
    pdfcraft: { state: "held", version: "0.21.1", reason: "tests failed (same version, new files)", link: "https://github.com/o/r/issues/53" },
  }), "x");
  assert.ok(page.includes("0 of 3 packages up to date"), "neither is current");
  assert.equal(text(page.match(/<p class="counts">[\s\S]*?<\/p>/)![0]).trim(), "1 held · 1 testing · 1 pulled upstream");
  assert.ok(text(rowOf(page, "photocraft")).includes("Testing 0.23.1 (same version, new files)"));
  const studio = text(rowOf(page, "artcraft-studio"));
  assert.ok(studio.includes("Going back to 0.41.0") && studio.includes("upstream pulled this release; main follows back after the tests") && studio.includes("waiting for the next run"));
  assert.ok(rowOf(page, "artcraft-studio").includes('class="cell state back"'));
  assert.ok(text(rowOf(page, "pdfcraft")).includes("Held: tests failed (same version, new files)"));
  const underway = text(page.match(/<section class="notice underway"[\s\S]*?<\/section>/)![0]);
  assert.ok(underway.includes("ArtCraft Studio : going back to 0.41.0: upstream pulled this release; main follows back after the tests · since"), underway);
  assert.ok(underway.includes("testing 0.23.1 (same version, new files)"));
});

test("page: a pulled pin with nothing to go back to stays", () => {
  const page = html([row("artcraft-studio", { version: "0.41.1" })], "o/r", live({
    "artcraft-studio": { state: "pulled", version: "0.41.1", stays: true, reason: "upstream pulled this release, and no earlier one is eligible; the pin stays" },
  }), "x");
  const studio = text(rowOf(page, "artcraft-studio"));
  assert.ok(studio.includes("Pulled upstream; stays at 0.41.1") && !studio.includes("Going back"), studio);
});

test("page: a demo build says so, with its clock and its sample rows", () => {
  const demo: DemoInfo = { now: "2026-11-22T14:05:00.000Z", real: "upstream's `publishedAt`.", invented: "PhotoCraft 0.23.2.", sample: ["photocraft"] };
  const page = html([row("photocraft"), row("pdfcraft")], "o/r", live({ photocraft: { state: "testing", version: "0.23.2" }, pdfcraft: ok }), "x", null, null, demo);
  assert.ok(page.includes('data-demo="2026-11-22T14:05:00.000Z"') && page.includes("<title>Demo: Package status · artcraft-nix</title>"));
  assert.ok(page.indexOf('<section class="demo"') < page.indexOf('<section class="hero"'));
  assert.ok(page.includes("<strong>Real:</strong> upstream&#39;s <code>publishedAt</code>."));
  assert.ok(rowOf(page, "photocraft").includes('<span class="tag sample">sample</span>') && !rowOf(page, "pdfcraft").includes("sample"));
});

test("styles: contrast of every text pair, icon and bar, in both schemes", () => {
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+): (#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = tokens(STYLE.slice(0, STYLE.indexOf("@media (prefers-color-scheme: dark)")));
  const dark = { ...light, ...tokens(STYLE.slice(STYLE.indexOf("@media (prefers-color-scheme: dark)"), STYLE.indexOf("* { box-sizing"))) };
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const textPairs = [["text", "surface"], ["text", "hover"], ["text", "page"], ["muted", "surface"], ["muted", "hover"], ["muted", "page"], ["muted", "none-bg"],
    ["link", "surface"], ["link", "hover"], ["link", "page"], ["ok", "ok-bg"], ["move", "move-bg"], ["held", "held-bg"], ["none", "none-bg"], ["bad", "bad-bg"],
    ["sample", "sample-bg"], ["text", "sample-bg"], ["link", "sample-bg"], ["ok", "surface"], ["move", "surface"], ["held", "surface"], ["move", "hover"], ["held", "hover"], ["bad", "hover"]];
  const graphic = [["ok", "surface"], ["held", "surface"], ["slow", "surface"], ["bad", "surface"], ["move", "surface"], ["none", "surface"], ["approx", "surface"], ["focus", "surface"], ["focus", "page"],
    ["focus", "hover"], ["focus", "ok-bg"], ["focus", "move-bg"], ["focus", "held-bg"], ["focus", "none-bg"], ["focus", "bad-bg"],
    ["muted", "surface"], ["muted", "hover"], ["ok", "ok-bg"], ["move", "move-bg"], ["held", "held-bg"], ["bad", "bad-bg"]];
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    for (const [a, b] of textPairs) assert.ok(ratio(t[a], t[b]) >= 4.5, `${name} ${a} on ${b}: ${ratio(t[a], t[b]).toFixed(2)}`);
    for (const [a, b] of graphic) assert.ok(ratio(t[a], t[b]) >= 3, `${name} ${a} on ${b}: ${ratio(t[a], t[b]).toFixed(2)}`);
  }
});

// ---- The script --------------------------------------------------------

interface Opts {
  now?: number; replies?: (string | Error | "hang")[]; checked?: string | null; hidden?: boolean; focused?: boolean;
  storage?: "ok" | "throws" | "read-throws" | "malformed" | "fails-later" | "fails-first"; store?: Map<string, string>; dateHeader?: string | null;
  /** The reader's locale and time zone (default en-GB and UTC, which write
   * times as the page does); null: no Intl.DateTimeFormat. */
  reader?: { locale: string; zone: string } | null;
  /** Where the strip's bars sit in the window (default 300 px down). */
  barTop?: number;
  /** A demo build's clock (data-demo). */
  demo?: string;
}
/** A stub element for the strip's card: its text is its children's, joined
 * with "|". */
function node(o: Record<string, any> = {}): any {
  const classes = new Set<string>();
  const props: Record<string, string> = {};
  return {
    className: "", children: [] as any[], _text: "", parentNode: null, offsetWidth: 200, offsetHeight: 80, ...o,
    classes, props, style: { props, setProperty(k: string, v: string) { props[k] = v; } },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    appendChild(c: any) { c.parentNode = this; this.children.push(c); return c; },
    get textContent(): string { return this.children.length ? this.children.map((c: any) => c.textContent).join("|") : this._text; },
    set textContent(v: string) { this.children = []; this._text = v; },
    get lastElementChild() { return this.children.at(-1); },
    getAttribute(a: string) { return this.attrs?.[a] ?? null; },
    closest(q: string) { return q === ".strip g[data-at]" ? (this.isBar ? this : this.parentNode?.isBar ? this.parentNode : null) : null; },
    querySelector(q: string) { return q === ".hit" ? this.children.find((c: any) => c.className === "hit") : null; },
    getBoundingClientRect() { return this.rect; },
  };
}
/** Runs SCRIPT against a stub DOM. Replies are "A" (id A) or "A@<iso>" (id A
 * checked then), an Error (the fetch fails) or "hang" (never answers). */
function run(o: Opts = {}) {
  let now = o.now ?? Date.parse("2026-11-13T12:00:00Z");
  const el = (extra: Record<string, any> = {}): any => ({
    _hidden: extra.hidden ?? true, changes: 0, get hidden() { return this._hidden; }, set hidden(v: boolean) { if (v !== this._hidden) this.changes++; this._hidden = v; },
    classList: { set: new Set<string>(), toggle(c: string, on: boolean) { on ? this.set.add(c) : this.set.delete(c); } },
    listeners: [] as any[], addEventListener(_: string, fn: any) { this.listeners.push(fn); }, ...extra,
  });
  /** A <time>: counts how often its text changes. */
  const time = (cls: string, dateTime: string, title: string) => ({ cls, dateTime, title, _t: title, writes: 0, get textContent() { return this._t; }, set textContent(v: string) { this.writes++; this._t = v; } });
  const checkedEl = o.checked === null ? null : time("rel", o.checked ?? "2026-11-13T11:50:00.000Z", "13 Nov 2026, 11:50 UTC");
  const rels = [time("rel", "2026-11-13T11:59:30.000Z", "13 Nov 2026, 11:59 UTC"), time("rel", "2026-11-13T09:00:00.000Z", "13 Nov 2026, 09:00 UTC")];
  if (checkedEl) rels.push(checkedEl);
  const exactTime = time("", "2026-11-13T09:00:00.000Z", "13 Nov 2026, 09:00 UTC");
  // The strip's card and two bars, the second the newest.
  const tip = node();
  const svg = node();
  const bars = ["2026-11-13T09:00:00.000Z", "2026-11-13T11:52:00.000Z"].map((at, i) => {
    const g = svg.appendChild(node({ isBar: true, attrs: { "data-v": `1.${i}`, "data-d": i ? "8 min" : "~3 h", "data-note": i ? "to deliver" : "approximate: file uploaded", "data-band": i ? "good" : "approx", "data-at": at } }));
    g.appendChild(node({ className: "hit", rect: { left: 100 + 9 * i, width: 9, top: o.barTop ?? 300, bottom: (o.barTop ?? 300) + 16 } }));
    g.appendChild(node());
    return g;
  });
  // The footer's exact check time, when there is one.
  const foot = time("", checkedEl?.dateTime ?? "", checkedEl?.title ?? "");
  const times = [...rels, exactTime, ...(checkedEl ? [foot] : [])];
  const els: Record<string, any> = { ".stale-note": el(), ".at-last": el(), ".stale-icon": el(), ".status-line": el(), "#checked-exact": foot, "#tip": tip };
  const leads = [el({ hidden: false })];
  const state = { details: false, selection: "", hidden: o.hidden ?? false, focused: o.focused ?? true, reloads: 0, fetches: 0, aborted: 0, urls: [] as string[], caches: [] as (string | undefined)[] };
  const store = o.store ?? new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (k: string) => { if (o.storage === "throws" || o.storage === "read-throws") throw new Error("blocked"); if (o.storage === "malformed") return "{not json"; return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { writes++; if (o.storage === "throws" || (o.storage === "fails-later" && writes > 1) || (o.storage === "fails-first" && writes === 1)) throw new Error("full"); store.set(k, v); },
  };
  const intervals: [() => unknown, number][] = [], timeouts: (() => void)[] = [], delays: number[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const replies = [...(o.replies ?? [])];
  const hung: { resolve: (v: any) => void; signal: unknown }[] = [];
  const reply = (r: string) => {
    const [id, checked] = r.split("@");
    return { headers: { get: (h: string) => (h === "date" ? o.dateHeader ?? null : null) }, json: async () => ({ id, checked: checked ?? null }) };
  };
  class FixedDate extends Date { static now() { return now; } }
  const document = {
    documentElement: { dataset: { id: "A", ...(o.demo ? { demo: o.demo } : {}) }, clientWidth: 1000 },
    get hidden() { return state.hidden; },
    hasFocus: () => state.focused,
    querySelector: (q: string) => (q === "#checked" ? checkedEl : q === "details[open]" ? (state.details ? {} : null) : els[q] ?? null),
    querySelectorAll: (q: string) => (q === "time" ? times : q === "time.rel" ? times.filter((t) => t.cls === "rel") : q === "time:not(.rel)" ? times.filter((t) => t.cls !== "rel")
      : q === ".lead:not(.stale-icon)" ? leads : []),
    createElement: () => node(),
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
  };
  // The reader's defaults: an undefined locale or a missing time zone is theirs.
  const reader = o.reader === undefined ? { locale: "en-GB", zone: "UTC" } : o.reader;
  const DateTimeFormat = reader && function (locale?: string, opts: Intl.DateTimeFormatOptions = {}) {
    return new Intl.DateTimeFormat(locale ?? reader.locale, { timeZone: reader.zone, ...opts });
  };
  vm.runInNewContext(SCRIPT, {
    document, sessionStorage: storage, location: { reload: () => { state.reloads++; } }, Intl: { RelativeTimeFormat: Intl.RelativeTimeFormat, ...(DateTimeFormat ? { DateTimeFormat } : {}) }, Date: FixedDate, Math, Number, JSON, String, Array,
    getSelection: () => state.selection,
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
    setInterval: (fn: () => unknown, ms: number) => { intervals.push([fn, ms]); },
    setTimeout: (fn: () => void, ms: number) => { timeouts.push(fn); delays.push(ms); return timeouts.length; }, clearTimeout: () => {},
    AbortController: class { signal = { aborted: false }; abort() {
      state.aborted++;
      this.signal.aborted = true;
      // Only a fetch given this controller's signal is aborted.
      for (const h of hung.filter((f) => f.signal === this.signal)) h.resolve(Promise.reject(new Error("aborted")));
    } },
    fetch: (url: string, init?: { signal?: unknown; cache?: string }) => {
      state.fetches++;
      state.urls.push(url);
      state.caches.push(init?.cache);
      const next = replies.length ? replies.shift()! : "A";
      if (next === "hang") return new Promise((resolve) => hung.push({ resolve, signal: init?.signal }));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(reply(next));
    },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    state, els, leads, rels, checkedEl, exactTime, tip, bars, listeners, foot, store, intervals, timeouts, delays, flush,
    /** Answers the oldest hanging check. */
    answer: async (r: string) => {
      const h = hung.shift();
      assert.ok(h, "answer(): no check is hanging");
      h.resolve(reply(r));
      await flush();
    },
    /** One minute passes: the interval runs. */
    minute: async () => { now += 60e3; intervals[0][0](); await flush(); },
    advance: (ms: number) => { now += ms; },
    fire: (t: string) => { for (const fn of listeners[t] ?? []) fn(); },
    blur: () => { state.focused = false; for (const fn of listeners.blur ?? []) fn(); },
    focus: () => { state.focused = true; for (const fn of listeners.focus ?? []) fn(); },
    hide: () => { state.hidden = true; for (const fn of listeners.visibilitychange ?? []) fn(); },
    show: async () => { state.hidden = false; for (const fn of listeners.visibilitychange ?? []) fn(); await flush(); },
  };
}

test("script: wording, one interval, checks on start, every minute visible, never hidden, and on return", async () => {
  const p = run();
  await p.flush();
  assert.deepEqual(p.intervals.map(([, ms]) => ms), [60e3], "one interval");
  assert.equal(p.state.fetches, 1, "a check on start");
  assert.match(p.state.urls[0], /^live\.json\?t=\d+$/, "the tiny file, past any cache");
  assert.equal(p.state.caches[0], "no-store");
  assert.deepEqual(p.rels.map((t) => t.textContent), ["just now", "3 hours ago", "10 minutes ago"], "drawn once on start; under a minute is just now");
  assert.equal(p.exactTime.textContent, "13 Nov 2026, 09:00 UTC", "an exact time is drawn once, in the reader's zone");
  assert.equal(p.exactTime.writes, 0, "the same text: not rewritten");
  await p.minute();
  assert.equal(p.state.fetches, 2, "visible: every minute");
  p.hide();
  for (let i = 0; i < 30; i++) await p.minute();
  assert.equal(p.state.fetches, 2, "hidden: never, however long");
  await p.show();
  assert.equal(p.state.fetches, 3, "straight away on becoming visible");
  assert.ok(new Set(p.state.urls).size === 3, "each past any cache");
  // The interval's turn within 30 s of the return's check: skipped.
  const tick = async (ms: number) => { p.advance(ms); p.intervals[0][0](); await p.flush(); };
  await tick(20e3);
  assert.equal(p.state.fetches, 3, "not again 20 s after the return's check");
  await tick(20e3);
  assert.equal(p.state.fetches, 4, "40 s after it: checks");
  // The clock set back an hour: the minute's checks go on.
  p.advance(-3600e3);
  await p.minute();
  assert.equal(p.state.fetches, 5, "a clock set back doesn't stop checks");
});

test("script: times stand still while someone reads, move while nobody's there, and catch up on return", async () => {
  const p = run();
  await p.flush();
  const writes = () => p.rels.map((t) => t.writes).reduce((a, b) => a + b);
  const before = writes();
  for (let i = 0; i < 5; i++) await p.minute();
  assert.equal(writes(), before, "reading: no time changes");
  assert.equal(p.rels[0].textContent, "just now");
  // A short blur (the find bar): nothing, neither during it nor on return.
  p.blur();
  await p.minute();
  p.focus();
  assert.equal(writes(), before);
  // A real absence: unfocused for 2 minutes, then times move each minute.
  p.blur();
  await p.minute();
  await p.minute();
  assert.equal(p.rels[0].textContent, "8 minutes ago", "away (12:08): redrawn");
  await p.minute();
  assert.equal(p.rels[0].textContent, "9 minutes ago");
  // Back: one redraw; a second return in a row changes nothing.
  p.advance(30e3);
  p.focus();
  assert.equal(p.rels[0].textContent, "10 minutes ago", "redrawn on return");
  const after = writes();
  await p.show();
  p.focus();
  assert.equal(writes(), after, "two returns in a row: nothing the second time");
  // Hidden counts as away at once.
  p.hide();
  await p.minute();
  assert.equal(p.rels[0].textContent, "11 minutes ago");
});

test("script: exact times in the reader's own time zone, or UTC without Intl", async () => {
  const ny = run({ reader: { locale: "en-US", zone: "America/New_York" }, replies: ["A", "A@2026-11-13T11:55:00.000Z"] });
  await ny.flush();
  assert.equal(ny.exactTime.textContent, "13 Nov 2026, 4:00 AM EST");
  assert.deepEqual(ny.rels.map((t) => t.title), ["13 Nov 2026, 6:59 AM EST", "13 Nov 2026, 4:00 AM EST", "13 Nov 2026, 6:50 AM EST"], "the hover text too");
  assert.equal(ny.foot.textContent, "13 Nov 2026, 6:50 AM EST", "the footer's check time");
  for (const f of ny.listeners.pointerover) (f as any)({ target: ny.bars[1].children[0] });
  assert.ok(ny.tip.textContent.endsWith("|Published 8 minutes ago · 13 Nov 2026, 6:52 AM EST"), "the strip's card");
  await ny.minute();
  ny.hide();
  await ny.minute();
  assert.deepEqual([ny.checkedEl!.title, ny.foot.textContent], ["13 Nov 2026, 6:55 AM EST", "13 Nov 2026, 6:55 AM EST"], "a newer check time, in the same zone");
  // Another locale's clock and zone name; the date by the zone, not by UTC
  // (23:30 UTC is the next day in Berlin).
  const tokyo = run({ reader: { locale: "en-GB", zone: "Asia/Tokyo" } });
  assert.equal(tokyo.exactTime.textContent, "13 Nov 2026, 18:00 GMT+9");
  const berlin = run({ reader: { locale: "en-GB", zone: "Europe/Berlin" }, checked: "2026-11-13T23:30:00.000Z" });
  assert.equal(berlin.checkedEl!.title, "14 Nov 2026, 00:30 CET");
  // A reader outside English: the page's English, with their 12- or 24-hour
  // clock, never their digits or script.
  const cairo = run({ reader: { locale: "ar-EG", zone: "Africa/Cairo" } });
  assert.match(cairo.exactTime.textContent, /^13 Nov 2026, 11:00 am [A-Za-z0-9+:]+$/);
  const seoul = run({ reader: { locale: "ko-KR", zone: "Asia/Seoul" } });
  assert.match(seoul.exactTime.textContent, /^13 Nov 2026, 6:00 pm [A-Za-z0-9+:]+$/);
  const paris = run({ reader: { locale: "de-DE", zone: "Europe/Paris" } });
  assert.match(paris.exactTime.textContent, /^13 Nov 2026, 10:00 [A-Za-z0-9+:]+$/);
  // September as the page writes it ("Sep", not en-GB's "Sept").
  const sep = run({ reader: { locale: "en-GB", zone: "UTC" }, checked: "2026-09-13T09:00:00.000Z" });
  assert.equal(sep.checkedEl!.title, "13 Sep 2026, 09:00 UTC");
  for (const p of [cairo, seoul, paris, sep]) { await p.flush(); p.hide(); }
  const none = run({ reader: null });
  assert.equal(none.exactTime.textContent, "13 Nov 2026, 09:00 UTC", "no Intl.DateTimeFormat: UTC as built");
  assert.equal(none.exactTime.writes, 0);
  for (const f of none.listeners.pointerover) (f as any)({ target: none.bars[1].children[1] });
  assert.ok(none.tip.textContent.endsWith("|Published 8 minutes ago · 13 Nov 2026, 11:52 UTC"));
  for (const p of [tokyo, berlin, none]) { await p.flush(); p.hide(); }
});

test("script: the strip's card", async () => {
  const p = run();
  const fire = (t: string, e: Record<string, any>) => { for (const f of p.listeners[t] ?? []) (f as any)(e); };
  const [old, latest] = p.bars;
  assert.ok(!p.tip.classes.has("show"), "closed at first");
  // The pointer on the newest bar: it grows, and the card opens over it.
  fire("pointerover", { target: latest.children[0], pointerType: "mouse" });
  assert.ok(latest.classes.has("on") && p.tip.classes.has("show") && !p.tip.classes.has("below"));
  assert.ok(!p.tip.classes.has("glide"), "opens in place");
  assert.equal(p.tip.textContent, "1.1|Latest||8 min|to deliver|Published 8 minutes ago · 13 Nov 2026, 11:52 UTC");
  assert.equal(p.tip.children[1].children[0].className, "tip-dot good");
  // Centred on the bar (109 + 4.5), 12 px over it; the arrow on the bar.
  assert.equal(p.tip.style.props["--ax"], "100px");
  assert.equal(p.tip.style.left, "13.5px");
  assert.equal(p.tip.style.top, "208px");
  // Along to the older bar: the card moves, no "Latest", the first bar shrinks.
  fire("pointerout", { target: latest.children[0], relatedTarget: old.children[1], pointerType: "mouse" });
  assert.ok(p.tip.classes.has("show"), "still open between bars");
  fire("pointerover", { target: old.children[1], pointerType: "mouse" });
  assert.ok(old.classes.has("on") && !latest.classes.has("on"));
  assert.ok(p.tip.classes.has("glide"), "glides from bar to bar");
  assert.equal(p.tip.textContent, "1.0||~3 h|approximate: file uploaded|Published 3 hours ago · 13 Nov 2026, 09:00 UTC");
  // A mouse leaving the strip closes it.
  fire("pointerout", { target: old.children[0], relatedTarget: null, pointerType: "mouse" });
  assert.ok(!p.tip.classes.has("show") && !old.classes.has("on"));
  // A tap opens it and keeps it open; a tap elsewhere closes it.
  fire("pointerover", { target: old.children[0], pointerType: "touch" });
  fire("pointerdown", { target: old.children[0], pointerType: "touch" });
  fire("pointerout", { target: old.children[0], relatedTarget: null, pointerType: "touch" });
  assert.ok(p.tip.classes.has("show"));
  fire("pointerdown", { target: p.tip, pointerType: "touch" });
  assert.ok(!p.tip.classes.has("show"));
  // Escape, a scroll and a resize close it too.
  for (const close of [() => fire("keydown", { key: "Escape" }), () => fire("scroll", {}), () => fire("resize", {})]) {
    fire("pointerover", { target: latest.children[0], pointerType: "mouse" });
    assert.ok(p.tip.classes.has("show"));
    close();
    assert.ok(!p.tip.classes.has("show") && !latest.classes.has("on"));
  }
  // No room over the bar: under it.
  const low = run({ barTop: 50 });
  for (const f of low.listeners.pointerover) (f as any)({ target: low.bars[0].children[0] });
  assert.ok(low.tip.classes.has("below"));
  assert.equal(low.tip.style.top, "78px");
  for (const x of [p, low]) { await x.flush(); x.hide(); }
});

test("script: a newer check time waits for a redraw; an older one is ignored", async () => {
  // (The first check is part of loading the page: it draws everything.)
  const p = run({ replies: ["A", "A@2026-11-13T11:55:00.000Z", "A@2026-11-13T11:40:00.000Z"] });
  await p.flush();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:50:00.000Z", "reading: not shown yet");
  assert.equal(p.foot.textContent, "13 Nov 2026, 11:50 UTC");
  p.hide();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:55:00.000Z", "away: shown at the redraw");
  assert.equal(p.checkedEl!.title, "13 Nov 2026, 11:55 UTC");
  assert.deepEqual([p.foot.dateTime, p.foot.textContent], ["2026-11-13T11:55:00.000Z", "13 Nov 2026, 11:55 UTC"], "the footer follows");
  p.advance(5 * 60e3);
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:55:00.000Z", "an older time is ignored");
  assert.equal(p.state.reloads, 0);
});

test("script: out of date while reading: on once, with the checked words; off only at a redraw", async () => {
  // Data 1 h 55 min old; ten minutes later it's over 2 hours.
  const p = run({ checked: "2026-11-13T10:05:00.000Z", replies: [...Array(11).fill("A"), "A@2026-11-13T12:10:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.textContent, "1 hour ago");
  for (let i = 0; i < 10; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "on, while reading");
  assert.equal(p.checkedEl!.textContent, "2 hours ago", "with the checked line's own words");
  for (const q of [".at-last", ".stale-icon"]) assert.equal(p.els[q].hidden, false, q);
  assert.equal(p.leads[0].hidden, true);
  // A fresh check time arrives while reading: it stays on until a redraw.
  for (let i = 0; i < 3; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "never off while reading");
  assert.equal(p.els[".stale-note"].changes, 1, "one change");
  p.hide();
  await p.minute();
  assert.equal(p.els[".stale-note"].hidden, true, "off at the redraw");
});

test("script: a stale newer time and a failed check still turn out of date on", async () => {
  // A newer time that is itself over 2 hours old.
  const p = run({ checked: "2026-11-13T09:00:00.000Z", now: Date.parse("2026-11-13T10:30:00Z"), replies: ["A", "A@2026-11-13T09:10:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  p.advance(60 * 60e3);
  await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "11:31, checked 09:10: out of date");
  // Checks failing while someone reads.
  const q = run({ checked: "2026-11-13T10:01:00.000Z", replies: ["A", new Error("offline")] });
  await q.flush();
  q.advance(60e3);
  await q.minute();
  assert.equal(q.els[".stale-note"].hidden, false, "a failed check counts");
  // The visitor's clock 3 hours fast: corrected by the site's Date.
  const fast = run({ now: Date.parse("2026-11-13T15:00:00Z"), dateHeader: new Date("2026-11-13T12:00:00Z").toUTCString() });
  await fast.flush();
  assert.equal(fast.els[".stale-note"].hidden, true);
});

/** The ids a store holds tries for, without their times. */
const triesIn = (store: Map<string, string>) => JSON.parse(store.get("artcraft-nix-reloaded")!).map((e: string) => e.replace(/@\d+$/, ""));

test("script: a newer id reloads a visible tab at once, whoever is reading", async () => {
  // Someone reading, a section open and text selected: it reloads anyway
  // (the script no longer looks at either; this guards against it waiting
  // for them again).
  const reading = run({ replies: ["B", "B"] });
  reading.state.details = true;
  reading.state.selection = "codex";
  await reading.flush();
  assert.equal(reading.state.reloads, 1);
  // A newer id later on: at that check.
  const later = run({ replies: ["A", "B"] });
  await later.flush();
  assert.equal(later.state.reloads, 0);
  await later.minute();
  assert.equal(later.state.reloads, 1);
  // Nothing newer: no reload, at any check or on going to the background.
  const same = run({ replies: ["A", "A"] });
  await same.flush();
  await same.minute();
  same.hide();
  assert.equal(same.state.reloads, 0);
  assert.ok(!/\.newer|"\.reload"/.test(SCRIPT), "no link to show or wire up");
});

test("script: a hidden tab leaves a newer id to its check on becoming visible", async () => {
  // Opened in the background: no check until it's visible, then a reload.
  const opened = run({ replies: ["B"], hidden: true });
  await opened.flush();
  await opened.minute();
  assert.equal(opened.state.fetches, 0, "no check while hidden, not even on start");
  await opened.show();
  assert.equal(opened.state.reloads, 1, "on becoming visible");
  // A check out when the tab is hidden, answered with B: the same.
  const p = run({ replies: ["A", "hang", "B"] });
  await p.flush();
  await p.minute();
  p.hide();
  await p.answer("B");
  assert.equal(p.state.reloads, 0);
  await p.show();
  assert.equal(p.state.reloads, 1);
});

test("script: tries remembered, seeded with the page's own; a stale copy gets 3, 10 minutes apart", async () => {
  const store = new Map<string, string>();
  const p = run({ replies: ["A", "B", "A", "B"], store });
  await p.flush();
  assert.deepEqual(triesIn(store), ["A"], "seeded with its own id");
  for (let i = 0; i < 3; i++) await p.minute();
  assert.equal(p.state.reloads, 1);
  assert.deepEqual(triesIn(store), ["A", "B"]);
  // A cache still serves page A while live.json says B: each fresh run
  // tries again once 10 minutes have passed since the last try, 3 tries in
  // all within the hour (the first above), then none until they age out.
  const at = (hm: string) => Date.parse(`2026-11-13T${hm}:00.000Z`);
  const reloads: number[] = [];
  for (const start of ["12:05", "12:25", "12:40"]) {
    const again = run({ replies: Array(20).fill("B"), store, now: at(start) });
    await again.flush();
    for (let i = 0; i < 15 && !again.state.reloads; i++) await again.minute();
    reloads.push(again.state.reloads);
  }
  assert.deepEqual(reloads, [1, 1, 0]);
  const times = JSON.parse(store.get("artcraft-nix-reloaded")!).filter((e: string) => e.startsWith("B@")).map((e: string) => new Date(Number(e.slice(2))).toISOString().slice(11, 16));
  assert.deepEqual(times, ["12:01", "12:11", "12:25"], "10 minutes after the last, or at once if that's past");
  // An hour on, the tries have aged out: data that comes back to B is
  // reloaded for again.
  const back = run({ replies: ["B"], store, now: at("13:30") });
  await back.flush();
  assert.equal(back.state.reloads, 1);
  // A clock set back a day: the tries are a day away, not in the future.
  const behind = new Map([["artcraft-nix-reloaded", JSON.stringify(["A@" + at("12:00"), "B@" + at("12:00")])]]);
  const early = run({ replies: ["B"], store: behind, now: at("12:00") - 86400e3 });
  await early.flush();
  assert.equal(early.state.reloads, 1);
  // An older page's bare entry is a try long ago, so aged out.
  const old = new Map([["artcraft-nix-reloaded", JSON.stringify(["A", "B"])]]);
  const q = run({ replies: ["B"], store: old });
  await q.flush();
  assert.equal(q.state.reloads, 1);
  assert.deepEqual(triesIn(old), ["A", "B", "B"]);
  // Only the last 20 are kept.
  const many = new Map([["artcraft-nix-reloaded", JSON.stringify(Array.from({ length: 25 }, (_, i) => `x${i}`))]]);
  await run({ store: many }).flush();
  assert.equal(JSON.parse(many.get("artcraft-nix-reloaded")!).length, 20);
});

test("script: one check at a time, a hung one aborted after 15 seconds, and no extra timers", async () => {
  const p = run({ replies: ["hang", "A@2026-11-13T11:57:00.000Z"] });
  await p.flush();
  assert.equal(p.state.fetches, 1);
  await p.minute();
  assert.equal(p.state.fetches, 1, "no second check while one is out");
  p.hide();
  await p.show();
  assert.equal(p.state.fetches, 1, "becoming visible during a check: nothing more");
  assert.equal(p.intervals.length, 1, "events add no timers");
  assert.equal(p.delays.at(-1), 15e3);
  p.timeouts.at(-1)!();
  await p.flush();
  assert.equal(p.state.aborted, 1);
  assert.equal(p.state.fetches, 2, "the return's check, skipped while that one was out, starts as it ends");
  await p.flush();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:57:00.000Z", "and draws its answer at once, as a return's check does");
  p.hide();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:57:00.000Z", "and it works");
});

test("script: storage that can't be trusted never reloads by itself", async () => {
  for (const storage of ["throws", "read-throws", "malformed", "fails-later", "fails-first"] as const) {
    const p = run({ replies: ["B", "B", "B"], storage, checked: "2026-11-13T09:00:00.000Z" });
    await p.flush();
    p.advance(10 * 60e3);
    await p.minute();
    assert.equal(p.state.reloads, 0, `${storage}: no automatic reload`);
    p.hide();
    await p.minute();
    assert.equal(p.rels[0].textContent, "12 minutes ago", `${storage}: times work`);
    assert.equal(p.els[".stale-note"].hidden, false, `${storage}: the switch works`);
  }
  // A malformed entry in otherwise working storage counts as empty: replaced,
  // and the reload happens once.
  const junk = new Map([["artcraft-nix-reloaded", "{not json"]]);
  const healed = run({ replies: ["B", "B"], store: junk });
  await healed.flush();
  assert.equal(healed.state.reloads, 1);
  assert.deepEqual(triesIn(junk), ["A", "B"]);
  // Storage that worked for the first run and can't be read in the next.
  const store = new Map<string, string>();
  const first = run({ replies: ["B"], store });
  await first.flush();
  assert.equal(first.state.reloads, 1);
  const next = run({ replies: ["C", "C"], store, storage: "read-throws" });
  await next.flush();
  await next.minute();
  assert.equal(next.state.reloads, 0, "after a successful reload, reads failing: no loop");
});

test("script: no pause control", () => {
  assert.ok(!/paus|aria-pressed/i.test(SCRIPT));
});

test("script: the first check draws everything with the corrected clock", async () => {
  // Opened on a clock 3 hours fast: out of date at first sight, put right
  // by the first check's Date header.
  const p = run({ now: Date.parse("2026-11-13T15:00:00Z"), dateHeader: new Date("2026-11-13T12:00:00Z").toUTCString(), replies: ["A@2026-11-13T11:58:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:58:00.000Z");
  assert.equal(p.checkedEl!.textContent, "2 minutes ago");
});

test("script: a fresh newer time keeps out of date off while reading", async () => {
  // Data 1 h 55 min old; a newer time arrives while someone reads; ten
  // minutes later the switch is still off and the checked line unchanged.
  const p = run({ checked: "2026-11-13T10:05:00.000Z", replies: ["A", "A@2026-11-13T11:59:00.000Z"] });
  await p.flush();
  for (let i = 0; i < 10; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T10:05:00.000Z");
});

test("script: coming back to the tab redraws at once, and its check is drawn in full", async () => {
  const p = run();
  await p.flush();
  p.hide();
  await p.minute();
  assert.equal(p.rels[0].textContent, "1 minute ago", "the minute's redraw (12:01)");
  p.advance(30e3);
  await p.show();
  assert.equal(p.rels[0].textContent, "2 minutes ago", "redrawn on becoming visible, between minutes (12:01:30)");
  // A tab frozen for hours comes back: its old check time makes it out of
  // date, but the check on return brings a fresh time, drawn in full.
  const q = run({ replies: ["A", "A@2026-11-13T16:58:00.000Z"] });
  await q.flush();
  q.state.hidden = true;
  q.advance(5 * 3600e3);
  await q.show();
  assert.equal(q.els[".stale-note"].hidden, true, "not out of date after the return check");
  assert.equal(q.checkedEl!.dateTime, "2026-11-13T16:58:00.000Z");
  // The same after a sleep in a visible, focused tab: the minute's check
  // settles, not the timer before it.
  const r = run({ replies: ["A", "A@2026-11-13T16:58:00.000Z"] });
  await r.flush();
  r.advance(5 * 3600e3);
  await r.minute();
  assert.equal(r.els[".stale-note"].hidden, true);
});

test("script: a missed focus event doesn't leave a reader counted as away", async () => {
  const p = run({ replies: ["A", "A", "A", "A"] });
  await p.flush();
  p.blur();
  p.state.focused = true; // focus came back, but no event arrived
  await p.minute();
  await p.minute();
  await p.minute();
  assert.equal(p.rels[0].textContent, "just now", "hasFocus() says someone is there: the times stand still");
});

test("script: coming back redraws before the return check answers", async () => {
  const p = run({ replies: ["A", "hang"] });
  await p.flush();
  p.hide();
  p.advance(150e3);
  await p.show();
  assert.equal(p.state.fetches, 2, "the return check is out");
  assert.equal(p.rels[0].textContent, "3 minutes ago", "times already redrawn");
});

test("script: a check still out when the tab comes back is drawn in full", async () => {
  // A check went out just before the tab was hidden, and is still out when
  // the reader returns after hours; its fresh answer must not leave "Out of
  // date" showing.
  const p = run({ replies: ["A", "hang"] });
  await p.flush();
  await p.minute();
  p.hide();
  p.advance(5 * 3600e3);
  await p.minute();
  assert.equal(p.state.fetches, 2, "the check is out");
  await p.show();
  assert.equal(p.state.fetches, 2, "no second check");
  assert.equal(p.els[".stale-note"].hidden, false, "old data, for now");
  await p.answer("A@2026-11-13T16:59:00.000Z");
  assert.equal(p.els[".stale-note"].hidden, true, "the outstanding check's answer is drawn in full");
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T16:59:00.000Z");
});

type Stores = { session: Map<string, string>; local: Map<string, string> };
interface BoltOpts {
  rows: Record<string, string>; stores?: Stores; session?: string; local?: string; storage?: "ok" | "throws" | "write-throws";
  /** Reduced motion (the default): a version in view is remembered, with no strike drawn. */
  still?: boolean; hidden?: boolean; observer?: boolean;
  /** live.json's ids for each check in turn, the last one repeated (the
   * page's is "A"); "hang": that check never answers; "later": it answers
   * when answer() is called. */
  live?: string[]; narrow?: boolean;
}
/** Runs SCRIPT against a stub DOM with package rows in one card, for the
 * bolt: rows 70px apart under the On main heading, timers run by hand. */
function bolt(o: BoltOpts) {
  const KEY = "artcraft-nix-seen";
  const stores: Stores = o.stores ?? { session: new Map(o.session ? [[KEY, o.session]] : []), local: new Map(o.local ? [[KEY, o.local]] : []) };
  const store = (m: Map<string, string>) => ({
    getItem: (k: string) => { if (o.storage === "throws") throw new Error("blocked"); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (o.storage === "throws" || o.storage === "write-throws") throw new Error("full"); m.set(k, v); },
  });
  const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
  const body: any[] = [];
  const node = (tag: string): any => ({ tag, children: [] as any[], attrs: {} as Record<string, string>, className: "", textContent: "", title: "", style: {},
    classList: { set: new Set<string>(), add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); } },
    setAttribute(k: string, v: string) { this.attrs[k] = v; }, appendChild(c: any) { this.children.push(c); return c; },
    getTotalLength: () => 100, animate: () => ({}), remove() { body.splice(body.indexOf(this), 1); } });
  const head = { getClientRects: () => (o.narrow ? [] : [rect(400, 0, 600, 40)]), getBoundingClientRect: () => rect(400, 0, 600, 40) };
  const card = { querySelector: (q: string) => (q === ".col-ver" ? head : null), getBoundingClientRect: () => rect(0, 0, 1000, 1000) };
  const cells = new Map<string, any>(), rowsBy = new Map<string, any>();
  const rows = Object.entries(o.rows).map(([name, v], i) => {
    const cell = Object.assign(node("div"), {
      childNodes: [] as any[], getBoundingClientRect: () => rect(400, 100 + 70 * i, 600, 120 + 70 * i),
      querySelector(this: any, q: string) { return q === ".zap-tag" ? this.children.find((c: any) => c.className === "zap-tag") : null; },
    });
    cells.set(name, cell);
    const row = { id: `pkg-${name}`, dataset: { v }, classList: node("li").classList, querySelector: (q: string) => (q === ".cell.ver" ? cell : null), closest: () => card };
    rowsBy.set(name, row);
    return row;
  });
  const nameOf = (c: any) => [...cells].find(([, x]) => x === c)![0];
  const io = { callback: null as any, observing: new Set<string>(), observes: 0, queued: [] as any[] };
  const listeners: Record<string, (() => void)[]> = {};
  const state = { hidden: o.hidden ?? false, reloads: 0 };
  let timers: [() => void, number][] = [];
  const live = [...(o.live ?? ["A"])];
  let later: ((id: string) => void) | null = null, minute: (() => void) | null = null;
  const reply = (id: string) => ({ headers: { get: () => null }, json: async () => ({ id, checked: null }) });
  const document = {
    documentElement: { dataset: { id: "A" }, clientWidth: 1000, clientHeight: 800 },
    body: { animate: () => ({}), appendChild: (c: any) => { body.push(c); return c; } },
    get hidden() { return state.hidden; }, hasFocus: () => true,
    querySelector: (q: string) => (q === ".mark" ? { namespaceURI: "svg" } : null),
    querySelectorAll: (q: string) => (q === ".pkg[data-v]" ? rows : []),
    createElement: node, createElementNS: (_: string, t: string) => node(t), createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
  };
  vm.runInNewContext(SCRIPT, {
    document, sessionStorage: store(stores.session), localStorage: store(stores.local), location: { reload: () => { state.reloads++; } },
    Intl, Date, Math, Number, JSON, String, Array, Object, Set, Map, scrollX: 0, scrollY: 0, getComputedStyle: () => ({ strokeWidth: "3px" }),
    matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" && (o.still ?? true) }),
    ...(o.observer === false ? {} : { IntersectionObserver: class {
      constructor(cb: any) { io.callback = cb; }
      observe(c: any) { io.observing.add(nameOf(c)); io.observes++; }
      unobserve(c: any) { io.observing.delete(nameOf(c)); }
      takeRecords() { const q = io.queued; io.queued = []; return q; }
    } }),
    addEventListener: () => {}, setInterval: (fn: () => void) => { minute = fn; }, setTimeout: (fn: () => void, ms: number) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: () => {},
    fetch: () => {
      const id = live.length > 1 ? live.shift()! : live[0];
      if (id === "later") return new Promise((resolve) => { later = (x) => resolve(reply(x)); });
      return id === "hang" ? new Promise(() => {}) : Promise.resolve(reply(id));
    },
    getSelection: () => "",
  });
  const seen = (m: Map<string, string>) => (m.has(KEY) ? JSON.parse(m.get(KEY)!) : null);
  return {
    stores, io, state, body, cell: (n: string) => cells.get(n), row: (n: string) => rowsBy.get(n),
    /** The rows with a small bolt. */
    tagged: () => [...cells].filter(([, c]) => c.children.length).map(([n]) => n),
    said: (n: string) => cells.get(n).children[0]?.children.map((c: any) => c.textContent).join(""),
    seen: () => ({ session: seen(stores.session), local: seen(stores.local) }),
    /** The start-up check of live.json answers. */
    flush: () => new Promise((r) => setImmediate(r)),
    /** The observer reports these cells, in view by this much. */
    view: (entries: Record<string, number>) => io.callback(Object.entries(entries).map(([n, ratio]) => ({ target: cells.get(n), isIntersecting: ratio > 0, intersectionRatio: ratio }))),
    /** A report the observer has queued but not yet delivered. */
    queue: (n: string, ratio: number) => { io.queued.push({ target: cells.get(n), isIntersecting: ratio > 0, intersectionRatio: ratio }); },
    /** The observer delivers what it still has queued. */
    deliver: () => { const q = io.queued; io.queued = []; if (q.length) io.callback(q); },
    /** Every timer runs, in order of when it's due. */
    run: () => { const due = timers.sort((a, b) => a[1] - b[1]); timers = []; for (const [fn] of due) fn(); },
    hide: () => { state.hidden = true; for (const fn of listeners.visibilitychange ?? []) fn(); },
    show: async () => { state.hidden = false; for (const fn of listeners.visibilitychange ?? []) fn(); await new Promise((r) => setImmediate(r)); },
    /** A minute passes (more than 30 s since the last check): the minute's check. */
    minute: async () => { const t = Date.now; Date.now = () => t() + 61e3; try { minute!(); } finally { Date.now = t; } await new Promise((r) => setImmediate(r)); },
    /** The check waiting on "later" answers. */
    answer: async (id: string) => { later!(id); await new Promise((r) => setImmediate(r)); },
  };
}

test("bolt: a first visit draws none and remembers what it showed, in the tab and the browser", async () => {
  const b = bolt({ rows: { codex: "2", pi: "1" } });
  await b.flush();
  assert.deepEqual(b.tagged(), []);
  assert.deepEqual(b.seen(), { session: { codex: "2", pi: "1" }, local: { codex: "2", pi: "1" } });
  assert.equal(b.io.callback, null, "nothing to watch");
});

test("bolt: a version changed since the last visit gets its small bolt at once, and is remembered once seen in full", async () => {
  const b = bolt({ rows: { codex: "2", pi: "1", fx: "3" }, local: JSON.stringify({ codex: "1", pi: "1" }) });
  assert.deepEqual(b.tagged(), ["codex"], "pi unchanged; fx new to the page");
  assert.equal(b.said("codex"), ", changed since your last visit");
  assert.deepEqual(b.seen().local, { codex: "1", pi: "1", fx: "3" }, "the rest remembered; codex not yet seen");
  assert.deepEqual([...b.io.observing], [], "not watched until the page is known current");
  await b.flush();
  assert.deepEqual([...b.io.observing], ["codex"]);
  b.view({ codex: 0.5 });
  assert.equal(b.seen().local.codex, "1", "partly in view: not yet");
  b.view({ codex: 1 });
  assert.deepEqual(b.seen(), { session: { codex: "2", pi: "1", fx: "3" }, local: { codex: "2", pi: "1", fx: "3" } });
  assert.deepEqual([...b.io.observing], [], "once");
});

test("bolt: a page about to reload for newer data strikes nothing and remembers nothing changed", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["B"] });
  await b.flush();
  assert.equal(b.state.reloads, 1);
  assert.deepEqual([...b.io.observing], []);
  assert.equal(b.seen().local.codex, "1");
  // A check that never answers: nothing yet either (it's aborted after 15 s, and then counts).
  const hung = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["hang"] });
  await hung.flush();
  assert.deepEqual([...hung.io.observing], []);
});

test("bolt: the newest report for a cell counts", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }) });
  await b.flush();
  const report = (...ratios: number[]) => b.io.callback(ratios.map((r) => ({ target: b.cell("codex"), isIntersecting: r > 0, intersectionRatio: r })));
  report(1, 0.5);
  assert.equal(b.seen().local.codex, "1", "in view, then partly out: not seen");
  report(0.5, 1);
  assert.equal(b.seen().local.codex, "2");
});

test("bolt: a reload before the version was seen keeps it; after, a reload doesn't strike again", async () => {
  const first = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }) });
  const before = bolt({ rows: { codex: "2" }, stores: first.stores });
  assert.deepEqual(before.tagged(), ["codex"], "never scrolled to: still changed");
  await before.flush();
  before.view({ codex: 1 });
  assert.deepEqual(bolt({ rows: { codex: "2" }, stores: before.stores }).tagged(), []);
});

test("bolt: the tab's own view wins over the browser's; a new tab starts from the browser's", () => {
  // Another tab already saw codex 2; this tab last showed 1.
  assert.deepEqual(bolt({ rows: { codex: "2" }, session: JSON.stringify({ codex: "1" }), local: JSON.stringify({ codex: "2" }) }).tagged(), ["codex"]);
  // A new tab: the browser's view, carried into the tab's, so its reload still knows codex.
  const b = bolt({ rows: { codex: "2", pi: "1" }, local: JSON.stringify({ codex: "1", pi: "1" }) });
  assert.deepEqual(b.seen().session, { codex: "1", pi: "1" });
  assert.deepEqual(bolt({ rows: { codex: "2", pi: "1" }, stores: b.stores }).tagged(), ["codex"]);
  // Junk in the tab's: the browser's.
  assert.deepEqual(bolt({ rows: { codex: "2" }, session: "{not json", local: JSON.stringify({ codex: "1" }) }).tagged(), ["codex"]);
});

test("bolt: none when storage can't be read or holds junk; a failed write still shows the bolt", async () => {
  assert.deepEqual(bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), storage: "throws" }).tagged(), []);
  for (const junk of ["{not json", "[]", "null", "7"]) {
    const b = bolt({ rows: { codex: "2" }, local: junk });
    assert.deepEqual(b.tagged(), [], junk);
    assert.deepEqual(b.seen().local, { codex: "2" }, "replaced with what it showed");
  }
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), storage: "write-throws" });
  assert.deepEqual(b.tagged(), ["codex"]);
  await b.flush();
  // Seen, and the write fails: no error.
  b.view({ codex: 1 });
});

test("bolt: a hidden tab strikes nothing until it is visible and current, then looks again", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), hidden: true });
  await b.flush();
  assert.equal(b.io.observes, 0, "no check while hidden, so nothing watched");
  await b.show();
  assert.equal(b.io.observes, 1, "watched after the return's check");
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "2");
  await b.show();
  assert.equal(b.io.observes, 1, "nothing left to watch");
});

test("bolt: without IntersectionObserver, the small bolt, remembered at once", () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), observer: false });
  assert.deepEqual(b.tagged(), ["codex"]);
  assert.equal(b.seen().local.codex, "2");
});

test("bolt: the strike, one chain per card down the column, or the landing alone on each version when narrow", async () => {
  const rows = { codex: "2", pi: "2", fx: "2" }, local = JSON.stringify({ codex: "1", pi: "1", fx: "1" });
  for (const narrow of [false, true]) {
    const b = bolt({ rows, local, still: false, narrow });
    await b.flush();
    b.view({ codex: 1, pi: 1, fx: 1 });
    assert.deepEqual(b.seen().local, { codex: "2", pi: "2", fx: "2" }, "seen: remembered at once");
    if (!narrow) {
      assert.equal(b.body.length, 1, "one layer for the card");
      assert.equal(b.body[0].style.clipPath, "inset(42px 400px 0px 392px)", "clipped to the column, under its heading");
      assert.ok(b.body[0].children.some((c: any) => c.tag === "g"), "lightning");
    }
    b.run();
    if (narrow) {
      assert.equal(b.body.length, 3, "a layer per version, made as it lands");
      assert.equal(b.body[0].style.clipPath, "inset(92px 400px 672px 392px)", "clipped to the version");
      assert.ok(!b.body.some((g: any) => g.children.some((c: any) => c.tag === "g")), "no lightning");
    }
    assert.ok(["codex", "pi", "fx"].every((n) => b.row(n).classList.set.has("zapped") && b.cell(n).children[0].classList.set.has("pop")));
    b.run();
    assert.equal(b.body.length, 0, "layers removed");
  }
});

test("bolt: back in the tab, nothing strikes until the return's check says the page is current", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["A", "hang"] });
  await b.flush();
  b.hide();
  await b.show();
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "1", "the check is still out: the page may be stale");
});

test("bolt: a check that started before the tab came back doesn't open the gate", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["A", "later", "later"] });
  await b.flush();
  await b.minute();
  b.hide();
  // The return's check is skipped: the minute's is still out.
  await b.show();
  await b.answer("A");
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "1", "its answer may be from before newer data went live");
  // The return's check, run when that one ended, answers.
  await b.answer("A");
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "2");
});

test("bolt: once a reload for newer data has started, nothing strikes", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["A", "B"] });
  await b.flush();
  await b.minute();
  assert.equal(b.state.reloads, 1);
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "1");
});

test("bolt: once a reload has started, a later check can't reopen the gate, even with the reload refused", async () => {
  // Reload asked for; back in the tab before it happens, the same newer id: its tries refuse a second reload.
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), live: ["A", "B"] });
  await b.flush();
  await b.minute();
  assert.equal(b.state.reloads, 1);
  b.hide();
  await b.show();
  assert.equal(b.state.reloads, 1, "refused");
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "1");
});

test("bolt: seen is remembered at once; the strike that follows only shows it", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }), still: false });
  await b.flush();
  b.view({ codex: 1 });
  assert.equal(b.seen().local.codex, "2", "before the strike lands");
  // Hidden before it lands: it still lands, and nothing changes.
  b.hide();
  b.run();
  assert.ok(b.row("codex").classList.set.has("zapped"));
  assert.equal(b.seen().local.codex, "2");
});

test("bolt: a report queued while the gate was shut is dropped when it opens", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }) });
  await b.flush();
  b.hide();
  // In full view a moment ago; scrolled away since, its fresh report still to come.
  b.queue("codex", 1);
  await b.show();
  b.deliver();
  assert.equal(b.seen().local.codex, "1");
  assert.ok(b.io.observing.has("codex"), "watched afresh");
});

test("bolt: a report with nothing in full view writes nothing", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }) });
  await b.flush();
  b.stores.session.clear();
  b.stores.local.clear();
  b.view({ codex: 0.5 });
  assert.deepEqual(b.seen(), { session: null, local: null });
});

test("bolt: a check while the gate is already open keeps the reports queued", async () => {
  const b = bolt({ rows: { codex: "2" }, local: JSON.stringify({ codex: "1" }) });
  await b.flush();
  b.queue("codex", 1);
  await b.minute();
  b.deliver();
  assert.equal(b.seen().local.codex, "2");
});

test("script: a demo build checks nothing and reads its times against its own clock", async () => {
  // The demo's clock is 3 hours after the reader's.
  const p = run({ demo: "2026-11-13T15:00:00.000Z" });
  await p.flush();
  assert.equal(p.state.fetches, 0, "no check of live.json");
  assert.deepEqual(p.rels.map((t) => t.textContent), ["3 hours ago", "6 hours ago", "3 hours ago"]);
  await p.minute();
  assert.equal(p.state.fetches, 0, "not every minute either");
  assert.equal(p.state.reloads, 0);
});
