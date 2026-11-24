// The status page's HTML (scripts/status.ts builds the data). As in
// t3code-nix: one static file, inline CSS, inline SVG and one inline script,
// nothing loaded from another site (its Content-Security-Policy says so: the
// script is allowed by its hash, and it may fetch only the site's own
// live.json). The output depends only on its inputs, so it stays
// deterministic: dates are written out in UTC, and the script turns the
// relative ones into "2 hours ago" and the exact ones into the reader's own
// time zone in the browser, says when the data is out of date, reloads when
// the site has newer data, and strikes each version changed since the
// reader's last visit with a bolt (see SCRIPT).
//
//   node scripts/status-page.ts --fixtures DIR --out OUT_DIR
//
// builds the site from fixtures, offline (the same as status.ts's).
import { createHash } from "node:crypto";
import { PACKAGE_ORDER, TITLES, titleOf } from "./lib/titles.ts";
import type { Delivery, DeliveryFigure, Released, Row, StableView } from "./status.ts";
import type { Live, PinState, StateName } from "./status-live.ts";

/** Each kind of upstream release time: a short label, and why the delay
 * from it is only approximate (null: exact). */
export const KIND: Record<Released["kind"], { label: string; why: string | null }> = {
  published: { label: "release", why: null },
  seen: {
    label: "first seen",
    why: "Upstream gives no release time; this is when artcraft-nix's update run saw the version, so the real delay may be longer.",
  },
};

/** A demo build: the clock the page reads its relative times against, and
 * what of its data is sample data (shown in a banner and on each row it
 * touches). */
export interface DemoInfo {
  now: string;
  /** What's real and what's invented, a sentence or two each. */
  real: string;
  invented: string;
  /** Packages whose state or history is invented. */
  sample: string[];
}

export const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Escaped, with `code` spans as in the README. */
const text = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  // Under an hour stays in minutes (3570 s isn't "1 h").
  if (s < 3600) return `${Math.min(m, 59)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** The same, rounded to its largest unit: for times only known roughly. */
export function roughly(s: number): string {
  if (s < 3600) return `${Math.min(59, Math.max(1, Math.round(s / 60)))} min`;
  if (s < 48 * 3600) return `${Math.min(47, Math.round(s / 3600))} h`;
  return `${Math.round(s / 86400)} d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Nov 2026, 10:17 UTC". */
export function utc(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** A time the script shows as "2 hours ago" (the exact time stays in the
 * title, and in the details or the footer). */
const rel = (iso: string) => `<time class="rel" datetime="${escape(iso)}" title="${escape(utc(iso))}">${escape(utc(iso))}</time>`;
/** A time shown exactly; the script rewrites it once, in the reader's time zone. */
const exact = (iso: string) => `<time datetime="${escape(iso)}">${escape(utc(iso))}</time>`;

/** A version, allowed to wrap after a "." (long versions on narrow screens). */
const version = (v: string) => escape(v).replace(/([-.])/g, "$1<wbr>");

/** Under an hour, under six, six or more: the badges' colours too. */
export function tone(gap: number): "good" | "fair" | "slow" {
  return gap < 3600 ? "good" : gap < 6 * 3600 ? "fair" : "slow";
}
const BAND = { good: "under 1 h", fair: "under 6 h", slow: "6 h or more" } as const;

// The state icons: each its own shape as well as its own colour, 16px,
// drawn with currentColor. Next to a word they're hidden from screen
// readers; alone (the headline's) they carry a label.
type Icon = "ok" | "found" | "back" | "testing" | "held" | "gone" | "wait" | "none" | "stale";
const CLASS: Record<StateName, Icon> = { current: "ok", found: "found", pulled: "back", testing: "testing", held: "held", unavailable: "gone", waiting: "wait", "not-checked": "none" };
const SHAPE: Record<Icon, string> = {
  ok: `<circle cx="8" cy="8" r="6.6"/><path d="M5.1 8.3l2 2 3.9-4.1"/>`,
  found: `<circle cx="8" cy="8" r="6.6"/><path d="M8 11.2V5.1M5.4 7.6 8 5l2.6 2.6"/>`,
  back: `<circle cx="8" cy="8" r="6.6"/><path d="M8 4.8v6.1M5.4 8.4 8 11l2.6-2.6"/>`,
  testing: `<path d="M6.2 1.9h3.6M6.8 1.9v3.9L3.4 11.9a1.3 1.3 0 0 0 1.1 2h7a1.3 1.3 0 0 0 1.1-2L9.2 5.8V1.9M4.7 9.9h6.6"/>`,
  held: `<path d="M5.6 1.6h4.8l4 4v4.8l-4 4H5.6l-4-4V5.6Z"/><path d="M6.6 5.9v4.2M9.4 5.9v4.2"/>`,
  gone: `<path d="M8 1.7 14.6 13.6H1.4Z"/><path d="M8 6.2v3.4M8 11.6v.1"/>`,
  wait: `<path d="M4 1.8h8M4 14.2h8M5 1.8c0 3.2 3 4.2 3 6.2s-3 3-3 6.2M11 1.8c0 3.2-3 4.2-3 6.2s3 3 3 6.2"/>`,
  none: `<circle cx="8" cy="8" r="6.6" stroke-dasharray="2.6 2.6"/><path d="M5.6 8h4.8"/>`,
  stale: `<circle cx="8" cy="8" r="6.6"/><path d="M8 4.6V8l2.3 1.5"/>`,
};
const LABEL: Record<Icon, string> = { ok: "All up to date", found: "Updates underway", back: "Updates underway", testing: "Updates underway", held: "Updates held", gone: "Packages unavailable",
  wait: "Waiting for upstream", none: "Not checked", stale: "Out of date" };
const icon = (kind: Icon, label?: string, extra = "") =>
  `<svg class="st ${kind}${extra}" viewBox="0 0 16 16" ${label ? `role="img" aria-label="${escape(label)}"` : `aria-hidden="true"`}>${SHAPE[kind]}</svg>`;

/** The project's mark, as t3code-nix's: the Nix flake and the bolt, with its
 * 10-second loop (a strike, the flake turning, the bolt popping in). Still
 * when motion is reduced. */
const rot = (r: number) => (r ? ` transform="rotate(${r} 50 50)"` : "");
const STRIKE = "M78.8-44.4 58-9.2 69.2-6 46.8 26 58 29.2 50 46.8";
const MARK = `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><defs><filter id="mark-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>`
  + `<path class="glow" d="${STRIKE}" pathLength="153"/><path class="strike" d="${STRIKE}" pathLength="153"/>`
  + `<g class="spin"><g class="flake">${[0, 60, 120, 180, 240, 300].map((r) => `<path d="M50 43V12M43.5 19 50 25.5 56.5 19"${rot(r)}/>`).join("")}</g>`
  + `<g class="energy">${[0, 60, 120, 180, 240, 300].map((r) => `<path d="M50 43V12" pathLength="100"${rot(r)}/>`).join("")}</g></g>`
  + `<g class="pop"><path class="bolt" d="M62 6 35 53H50L40 94 68 44H53Z" transform="translate(51 50) scale(.78) translate(-51 -50)"/></g></svg>`;

/** "PdfCraft CLI". */
const fullName = (n: string) => titleOf(n);

/** What a state says: "Testing 0.23.2", "Held: tests failed",
 * "New version 0.24.2". */
function says(s: PinState): string {
  switch (s.state) {
    case "testing": return `Testing ${s.version}${s.reason ? ` (${s.reason})` : ""}`;
    case "held": return `Held: ${s.reason}`;
    case "found": return `New version ${s.version}`;
    case "pulled": return s.stays ? `Pulled upstream; stays at ${s.version}` : `Going back to ${s.version}`;
    case "waiting": return `Waiting for ${s.version}`;
    case "unavailable": return "Unavailable";
    case "not-checked": return "Not checked";
    default: return "Up to date";
  }
}
/** Where a state's link goes, in words. */
const LINK_WORDS: Partial<Record<StateName, string>> = { testing: "View run", held: "View issue", waiting: "View issue", unavailable: "View issue", found: "Release notes", pulled: "Release notes" };
/** A state's own time, in words: since when it's been tested, gone or
 * pulled, or when the version was first seen. */
const sinceWord = (s: PinState) => (s.state === "held" || s.state === "found" ? "found" : "since");
const since = (s: PinState) => (s.since && ["testing", "held", "found", "pulled", "unavailable"].includes(s.state) ? `${sinceWord(s)} ${rel(s.since)}` : "");
/** Found and pulled: what the version waits for. */
const waits = (s: PinState) => (s.state === "found" || s.state === "pulled") && !!s.wait;

/** A link whose accessible name adds the package after the visible words. */
const more = (href: string, words: string, who: string) => `<a class="hit" href="${escape(href)}">${escape(words)}<span class="sr"> for ${escape(who)}</span></a>`;
const releaseUrl = (repo: string, name: string) => `https://github.com/${repo}/releases/tag/${encodeURIComponent(name)}`;

// ---- The headline card -----------------------------------------------

function figure(d: DeliveryFigure | null, target: number): string {
  if (!d) return "";
  const main = d.target ?? d.all!;
  const met = d.target ? (d.target.median < target ? `<span class="target ok">${icon("ok")}within the ${escape(duration(target))} target</span>`
    : `<span class="target held">${icon("held")}over the ${escape(duration(target))} target</span>`) : "";
  const label = d.target ? "Median delivery, last 30 days" : "Median delivery over all releases, last 30 days";
  const sub = d.target
    ? `Runs with no update run ahead, runner queue time left out (${d.target.count} releases).${d.all ? ` All releases, queueing included: ${escape(duration(d.all.median))} (${d.all.count}).` : ""}`
    : `Too few runs with no update run ahead for the target figure yet.`;
  return `<div class="figure">
<p class="figure-value">${escape(duration(main.median))}</p>
<p class="figure-label">${label}</p>
${met ? `<p class="figure-met">${met}</p>\n` : ""}<p class="figure-sub">${sub}</p>
</div>`;
}

/** The status line: the checked time (live view) and the status region,
 * whose "Out of date" the script shows. */
function statusLine(checked: string | null): string {
  const time = checked ? `<span class="checked-text">Checked against upstream <time class="rel" id="checked" datetime="${escape(checked)}" title="${escape(utc(checked))}">${escape(utc(checked))}</time></span>` : "";
  return `<p class="status-line">${time}<span class="live-status" role="status"><span class="stale-note" hidden>Out of date</span></span></p>`;
}

/** The latest change shown here: the packages whose versions arrived in the
 * newest commit that changed one of them, with their versions, the release
 * it made (a hand commit makes none), when, and the commit. */
export function latestLine(list: Row[], repo: string): string {
  const newest = list.filter((r) => r.published).sort((a, b) => (a.published!.at < b.published!.at ? 1 : a.published!.at > b.published!.at ? -1 : 0))[0]?.published;
  if (!newest) return "";
  const order = new Map(PACKAGE_ORDER.map((n, i) => [n, i]));
  const at = (n: string) => order.get(n) ?? PACKAGE_ORDER.length;
  const names = list.filter((r) => r.published?.commit === newest.commit && !TITLES[r.name]?.companionOf).sort((a, b) => at(a.name) - at(b.name) || a.name.localeCompare(b.name))
    .map((r) => `<strong>${escape(titleOf(r.name))}</strong> ${version(r.version)}`);
  const said = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
  const lead = newest.release
    ? `Latest release <a class="hit" href="${escape(releaseUrl(repo, newest.release))}">${escape(newest.release)}<span class="sr">, the latest release</span></a>: `
    : "Latest update: ";
  return `<p class="latest">${lead}${said} · ${rel(newest.at)} · <a class="hit" href="https://github.com/${escape(repo)}/commit/${escape(newest.commit)}">commit ${escape(newest.commit.slice(0, 7))}<span class="sr">, the latest update</span></a></p>\n`;
}

const COUNTED: [StateName, string, string][] = [["unavailable", "unavailable", "unavailable"], ["held", "held", "held"], ["testing", "testing", "testing"],
  ["waiting", "waiting for upstream", "waiting for upstream"], ["found", "new version found", "new versions found"],
  ["pulled", "pulled upstream", "pulled upstream"], ["not-checked", "not checked", "not checked"]];

function hero(list: Row[], live: Live | null, delivery: DeliveryFigure | null, repo: string, target: number): string {
  if (!live) {
    return `<section class="hero plain" aria-labelledby="headline">
<div class="hero-main"><div class="hero-text">
<h2 id="headline">${list.length} packages</h2>
${latestLine(list, repo)}<p class="note">Upstream status isn't available; these are the versions on <code>main</code>.</p>
${statusLine(null)}
</div></div>
${figure(delivery, target)}
</section>`;
  }
  const state = (n: string): StateName => live.states[n]?.state ?? "not-checked";
  const count = (s: StateName) => list.filter((r) => state(r.name) === s).length;
  const ok = count("current");
  const lead: Icon = count("unavailable") ? "gone" : count("held") ? "held" : count("testing") ? "testing" : count("waiting") ? "wait" : count("found") ? "found" : count("pulled") ? "back" : count("not-checked") ? "none" : "ok";
  const title = ok === list.length ? `All ${list.length} packages up to date` : `${ok} of ${list.length} packages up to date`;
  const counts = COUNTED.filter(([s]) => count(s) > 0)
    .map(([s, one, many]) => `<span class="count-item ${CLASS[s]}">${icon(CLASS[s])}${count(s)} ${count(s) > 1 ? many : one}</span>`);
  return `<section class="hero" aria-labelledby="headline">
<div class="hero-main"><span class="lead">${icon(lead, LABEL[lead])}</span><span class="lead stale-icon" hidden>${icon("stale", LABEL.stale)}</span><div class="hero-text">
<h2 id="headline">${escape(title)}<span class="at-last" hidden> at the last check</span></h2>
${counts.length ? `<p class="counts">${counts.join(`<span class="dot" aria-hidden="true"> · </span>`)}</p>\n` : ""}${latestLine(list, repo)}${statusLine(live.checked)}
</div></div>
${figure(delivery, target)}
</section>`;
}

/** Unavailable and held packages, always open; then the testing, waiting
 * and found ones. A companion that shares its app's state is listed with
 * it, not again. */
function activity(list: Row[], live: Live | null): string {
  if (!live) return "";
  const order = new Map(PACKAGE_ORDER.map((n, i) => [n, i]));
  const at = (n: string) => order.get(n) ?? PACKAGE_ORDER.length;
  const shared = (n: string) => {
    const app = TITLES[n]?.companionOf;
    return !!app && JSON.stringify(live.states[app]) === JSON.stringify(live.states[n]);
  };
  const line = (n: string) => {
    const s = live.states[n];
    const who = fullName(n);
    const what = s.state === "held" ? `${s.version ? `${version(s.version)}: ` : ""}${escape(s.reason ?? "")}`
      : s.state === "testing" ? `testing ${version(s.version ?? "")}${s.reason ? ` (${escape(s.reason)})` : ""}`
      : s.state === "waiting" ? `${version(s.version ?? "")}: ${escape(s.reason ?? "")}`
      : s.state === "unavailable" ? `${version(s.version ?? "")}: ${escape(s.reason ?? "")}`
      : s.state === "pulled" ? `${s.stays ? "stays at" : "going back to"} ${version(s.version ?? "")}: ${escape(s.reason ?? "")}`
      : `${version(s.version ?? "")} found`;
    const when = (s.since ? ` · ${sinceWord(s)} ${rel(s.since)}` : "") + (waits(s) ? ` · ${escape(s.wait!)}` : "");
    const link = s.link && LINK_WORDS[s.state] ? ` · ${more(s.link, LINK_WORDS[s.state]!, who)}` : "";
    const also = list.map((r) => r.name).filter((c) => TITLES[c]?.companionOf === n && shared(c)).map((c) => escape(titleOf(c)));
    return `<li>${icon(CLASS[s.state])}<span><strong>${escape(who)}</strong>${also.length ? ` (with ${also.join(", ")})` : ""}: ${what}${when}${link}</span></li>`;
  };
  const names = list.map((r) => r.name).filter((n) => live.states[n] && !shared(n));
  const pick = (states: StateName[]) => names.filter((n) => states.includes(live.states[n].state)).sort((a, b) => {
    const ra = states.indexOf(live.states[a].state), rb = states.indexOf(live.states[b].state);
    if (ra !== rb) return ra - rb;
    const ta = live.states[a].since, tb = live.states[b].since;
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    if (!!ta !== !!tb) return ta ? -1 : 1;
    return at(a) - at(b);
  });
  const attention = pick(["unavailable", "held"]), moving = pick(["testing", "waiting", "found", "pulled"]);
  return (attention.length ? `<section class="notice attention" aria-labelledby="attention">
<h2 id="attention">Needs attention</h2>
<ul>
${attention.map(line).join("\n")}
</ul>
</section>
` : "") + (moving.length ? `<section class="notice underway" aria-labelledby="underway">
<h2 id="underway">Updates underway</h2>
<ul>
${moving.map(line).join("\n")}
</ul>
</section>
` : "");
}

// ---- Package rows ------------------------------------------------------

const REASON: Record<Exclude<Row["counted"], true>, string> = { added: "Added", "re-added": "Re-added", returned: "Returned", older: "Older" };

/** A bar for one delivery: its band in colour and height, or neutral and
 * hatched when approximate, or a small outlined dot when not known. */
function bar(d: { gap: number | null; released: Released | null }, x: number): string {
  if (d.gap === null || !d.released) return `<circle class="b-none" cx="${x + 3}" cy="13.5" r="2"/>`;
  if (KIND[d.released.kind].why) return `<rect class="b-approx" x="${x}" y="6" width="6" height="10" rx="1"/>`;
  const t = tone(d.gap);
  const h = { good: 5, fair: 10, slow: 16 }[t];
  return `<rect class="b-${t}" x="${x}" y="${16 - h}" width="6" height="${h}" rx="1"/>`;
}

function deliveryCell(r: Row): string {
  if (r.counted !== true) return `<span class="reason">${REASON[r.counted]}</span>`;
  if (r.gap === null || !r.released) return `<span class="none-text" aria-hidden="true">—</span><span class="sr">not known</span>`;
  if (KIND[r.released.kind].why) return `~${escape(roughly(r.gap))}<span class="sr"> (approximately)</span>`;
  return `<svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar(r, 0)}</svg>${escape(duration(r.gap))}`;
}

/** "8 min"; "~3 h, approximate: first seen"; "not known". */
function deliveryWords(d: { gap: number | null; released: Released | null }): string {
  if (d.gap === null || !d.released) return "not known";
  if (KIND[d.released.kind].why) return `~${roughly(d.gap)}, approximate: ${KIND[d.released.kind].label}`;
  return duration(d.gap);
}

/** The median of some numbers (the mean of the middle two for an even
 * count), rounded. */
export function median(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q), mid = a.length >> 1;
  return Math.round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
}

function strip(h: Delivery[]): string {
  if (!h.length) return `<span class="muted">No deliveries yet</span>`;
  const oldestFirst = [...h].reverse();
  const exactGaps = h.filter((d) => d.gap !== null && d.released && !KIND[d.released.kind].why).map((d) => d.gap!).sort((a, b) => a - b);
  const n = h.length;
  let label = `Last ${n} ${n === 1 ? "delivery" : "deliveries"}`;
  if (exactGaps.length) label += `: median ${duration(median(exactGaps))}, slowest ${duration(exactGaps.at(-1)!)}; exact times only`;
  else label += "; no exact delivery times";
  return `<svg class="strip" viewBox="0 0 ${n * 9 - 3} 16" width="${n * 9 - 3}" height="16" role="img" aria-label="${escape(label)}">${oldestFirst.map((d, i) => tipped(d, i * 9)).join("")}</svg>`;
}

/** A strip bar, with its delivery for the script's card: the version, the
 * time it took and its band, and when it was published. A clear rect over
 * the bar's slot, gap included, makes short bars easy to hit. Hidden from
 * screen readers: the strip is one image with its summary as its name, and
 * the details list has each delivery. */
function tipped(d: Delivery, x: number): string {
  const known = d.gap !== null && d.released;
  const approx = known && KIND[d.released!.kind].why;
  const [band, took, note] = !known ? ["none", "Not known", "delivery time"]
    : approx ? ["approx", `~${roughly(d.gap!)}`, `approximate: ${KIND[d.released!.kind].label}`]
    : [tone(d.gap!), duration(d.gap!), "to deliver"];
  return `<g aria-hidden="true" data-v="${escape(d.version)}" data-d="${escape(took)}" data-note="${escape(note)}" data-band="${band}" data-at="${escape(d.published.at)}"><rect class="hit" x="${x - 1.5}" width="9" height="16"/>${bar(d, x)}</g>`;
}

/** Why the version shown isn't a delivery, in a sentence. */
function notCounted(r: Row): string {
  const v = escape(r.version);
  switch (r.counted) {
    case "added": return `${v} was on <code>main</code> when the package was added.`;
    case "re-added": return `${v} came with the package being added again.`;
    case "returned": return `${v} is back on <code>main</code>: it was there before.`;
    case "older": return `${v} is older than the version before it.`;
    default: return "";
  }
}

/** The package's NixOS stable version when it differs from main's. */
const stableOf = (stable: StableView | null, n: string) => stable?.differing.find((d) => d.name === n) ?? null;
function stableWords(stable: StableView | null, n: string): string {
  if (!stable) return "";
  const d = stableOf(stable, n);
  const gone = stable.unavailable.includes(n) ? ", unavailable there" : "";
  if (!d) return `The same as main${gone}`;
  if (d.marker === "main") return `${escape(d.stable ?? "")}, the same files; main marks it unavailable, the snapshot not yet`;
  if (d.marker === "stable") return `${escape(d.stable ?? "")}, the same files; unavailable there, available again on main`;
  if (d.stable === null) return `Not in the snapshot yet${gone}`;
  if (d.stable === d.main) return `${escape(d.stable)}, main a newer build of it${gone}`;
  return `${escape(d.stable)}, behind main${gone}`;
}

function details(r: Row, repo: string, s: PinState | undefined, stable: StableView | null): string {
  const who = fullName(r.name);
  const items: string[] = [];
  if (s && s.state !== "current") {
    const when = s.since ? `, ${sinceWord(s)} ${exact(s.since)}` : "";
    items.push(`<dt>State</dt><dd>${escape(says(s))}${["waiting", "unavailable", "pulled"].includes(s.state) ? `: ${escape(s.reason ?? "")}` : ""}${when}${waits(s) ? `; ${escape(s.wait!)}` : ""}</dd>`);
  }
  if (s && s.version && s.version !== r.version && s.state !== "waiting") items.push(`<dt>Upstream's latest</dt><dd>${escape(s.version)}</dd>`);
  items.push(`<dt>Released upstream</dt><dd>${r.released ? `${exact(r.released.at)} (${escape(KIND[r.released.kind].label)})${KIND[r.released.kind].why ? `. ${escape(KIND[r.released.kind].why!)}` : ""}` : "Not known"}</dd>`);
  items.push(`<dt>Published on <code>main</code></dt><dd>${r.published ? `${exact(r.published.at)}, ${r.published.release ? `in release <a href="${escape(releaseUrl(repo, r.published.release))}">${escape(r.published.release)}<span class="sr"> for ${escape(who)}</span></a>, ` : ""}<a href="https://github.com/${escape(repo)}/commit/${escape(r.published.commit)}">commit ${escape(r.published.commit.slice(0, 7))}<span class="sr"> for ${escape(who)}</span></a>` : "Not known"}</dd>`);
  if (r.unavailable) items.push(`<dt>Unavailable</dt><dd>Upstream's files for ${escape(r.version)} are gone, since ${exact(r.unavailable.since)}. Building it fails with a link to the issue; <code>default</code> and the module leave it out.</dd>`);
  if (stable) items.push(`<dt>NixOS stable</dt><dd>${stableWords(stable, r.name)}</dd>`);
  const why = r.counted === true ? "" : `<p>${notCounted(r)}</p>`;
  const hist = r.history.length
    ? `<ol class="hist">${r.history.map((d) => `<li><span class="v">${version(d.version)}</span> <span>${escape(deliveryWords(d))}</span> <span class="muted">${exact(d.published.at)}${d.published.release ? ` · ${escape(d.published.release)}` : ""}</span></li>`).join("")}</ol>`
    : `<p class="muted">No deliveries yet.</p>`;
  return `<details class="more"><summary>Details<span class="sr"> for ${escape(who)}</span></summary><div class="more-body">
<dl>${items.join("")}</dl>${why}
<h4 class="hist-title">Recent deliveries</h4>${hist}
</div></details>`;
}

function row(r: Row, repo: string, live: Live | null, stable: StableView | null, sample: Set<string>): string {
  const t = TITLES[r.name];
  const s = live ? live.states[r.name] ?? { state: "not-checked" as const } : undefined;
  const who = fullName(r.name);
  const heading = `<h3 class="pkg-name">${escape(titleOf(r.name))}</h3>`;
  const tags = sample.has(r.name) ? ` <span class="tag sample">sample</span>` : "";
  const ver = r.notes ? `<a class="hit" href="${escape(r.notes)}">${version(r.version)}<span class="sr">, release notes for ${escape(who)}</span></a>` : version(r.version);
  const behind = stableOf(stable, r.name);
  const stableTag = behind && behind.stable !== null && behind.stable !== behind.main ? `<span class="sub">stable ${version(behind.stable)}</span>`
    : behind && behind.stable === null ? `<span class="sub">not on stable yet</span>` : "";
  let stateCell = "";
  if (s) {
    const words = version(says(s));
    const linked = s.link && LINK_WORDS[s.state] ? `<a class="hit" href="${escape(s.link)}">${words}<span class="sr"> for ${escape(who)}</span></a>` : words;
    const extra = s.state === "held" && s.version ? ` <span class="v">${version(s.version)}</span>` : "";
    const when = [since(s), waits(s) ? escape(s.wait!) : "", s.state === "waiting" || s.state === "pulled" ? escape(s.reason ?? "") : ""].filter(Boolean).join(" · ");
    stateCell = `<div class="cell state ${CLASS[s.state]}"><span class="lbl">State </span><span><span class="state-words">${icon(CLASS[s.state])}<span>${linked}${extra}</span></span>${when ? `<span class="sub">${when}</span>` : ""}</span></div>`;
  }
  return `<li class="pkg${t?.companionOf ? " sub-pkg" : ""}" id="pkg-${escape(r.name)}" data-v="${escape(r.version)}">
<div class="cell who">${heading} <code class="attr">${escape(r.name)}</code>${tags}${t ? `<p class="desc">${text(t.description)}</p>` : ""}</div>
${stateCell}<div class="meta"><div class="cell ver"><span class="lbl">On main </span>${ver}${stableTag}</div>
<div class="cell dlv"><span class="lbl">Delivery </span>${deliveryCell(r)}</div>
<div class="cell recent"><span class="lbl">Recent deliveries </span>${strip(r.history)}</div></div>
${details(r, repo, s, stable)}
</li>`;
}

const COLS = (live: boolean) => `<div class="cols${live ? "" : " no-state"}" aria-hidden="true"><span>Package</span>${live ? "<span>State</span>" : ""}<span class="col-ver">On <code>main</code></span><span>Delivery</span><span>Recent deliveries</span><span></span></div>`;

/** The page's order: SOURCES' (each app with its companion right after it),
 * then any package the page doesn't know, by name. */
function pageOrder(list: Row[]): string[] {
  const has = new Set(list.map((r) => r.name));
  return [...PACKAGE_ORDER.filter((n) => has.has(n)), ...list.map((r) => r.name).filter((n) => !PACKAGE_ORDER.includes(n)).sort()];
}

/** The NixOS stable lines, two separate facts: whether the snapshot has
 * main's pins (current, or behind with what differs), and whether stable
 * builds pass (from the open stable-broken issue; left out without the
 * live reads). */
function stableLine(v: StableView, repo: string): string {
  const on = v.channel ? ` (<code>${escape(v.channel)}</code>)` : "";
  const issue = (n: number | null, words: string) => (n === null ? "" : ` <a href="https://github.com/${escape(repo)}/issues/${n}">${words} (#${n})</a>`);
  const gone = v.unavailable.length ? ` Unavailable there: ${v.unavailable.map((n) => escape(titleOf(n))).join(", ")}.` : "";
  const each = v.differing.map((d) =>
    d.marker === "main" ? `${escape(titleOf(d.name))} ${escape(d.main)} unavailable on main, not yet in the snapshot`
    : d.marker === "stable" ? `${escape(titleOf(d.name))} ${escape(d.main)} available again on main, still unavailable in the snapshot`
    : d.stable !== null && d.stable === d.main
      ? `${escape(titleOf(d.name))} ${escape(d.stable)}, main a newer build of it`
      : `${escape(titleOf(d.name))} ${d.stable === null ? "not yet" : escape(d.stable)}, main ${escape(d.main)}`);
  const snapshot = v.current
    ? `<p class="card-note stable-snapshot"><strong>Snapshot${on}:</strong> current, the same pins as main.${gone}</p>`
    : `<p class="card-note stable-snapshot"><strong>Snapshot${on}:</strong> behind main: ${each.join("; ")}.${issue(v.issue, "Why")}${gone}</p>`;
  const builds = v.builds === "broken"
    ? `<p class="card-note stable-builds"><strong>Builds:</strong> failing on NixOS stable; the snapshot doesn't move until they pass.${issue(v.broken, "Issue")}</p>`
    : v.builds === "ok" ? `<p class="card-note stable-builds"><strong>Builds:</strong> passing, no open stable failure.</p>` : "";
  return snapshot + builds;
}

function section(id: string, title: string, count: number | null, body: string, live: boolean, before = ""): string {
  return `<section class="group" aria-labelledby="${id}">
<h2 id="${id}">${escape(title)}${count === null ? "" : ` <span class="count">${count}</span>`}</h2>
<div class="card">${before}${body ? `${COLS(live)}\n${body}` : ""}</div>
</section>`;
}

function demoBanner(demo: DemoInfo): string {
  return `<section class="demo" aria-labelledby="demo-title">
<h2 id="demo-title"><span class="tag sample">sample</span> Demo with sample data</h2>
<p><strong>Real:</strong> ${text(demo.real)}</p>
<p><strong>Invented:</strong> ${text(demo.invented)} Rows whose state or history is invented are marked <span class="tag sample">sample</span>. Times read as of ${exact(demo.now)}.</p>
</section>
`;
}

export function html(list: Row[], repo: string, live: Live | null = null, id = "", stable: StableView | null = null, delivery: DeliveryFigure | null = null,
  demo: DemoInfo | null = null, target = 9 * 60): string {
  const by = new Map(list.map((r) => [r.name, r]));
  const repoUrl = `https://github.com/${escape(repo)}`;
  const sample = new Set(demo?.sample ?? []);
  const order = pageOrder(list);
  const studio = order.filter((n) => n === "artcraft-studio");
  const apps = order.filter((n) => n !== "artcraft-studio");
  const ul = (names: string[]) => `<ul class="pkgs" role="list">\n${names.map((n) => row(by.get(n)!, repo, live, stable, sample)).join("\n")}\n</ul>`;
  const sections = [
    apps.length ? section("apps", "Craft Apps", apps.filter((n) => !TITLES[n]?.companionOf).length, ul(apps), !!live) : "",
    studio.length ? section("studio", "ArtCraft Studio", null, ul(studio), !!live) : "",
    stable ? section("nixos-stable", "NixOS stable", null, "", !!live, stableLine(stable, repo)) : "",
  ].filter(Boolean).join("\n");
  const legend = (["good", "fair", "slow"] as const).map((t) => `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: { good: 60, fair: 3600, slow: 6 * 3600 }[t], released: { at: "", kind: "published" } }, 0)}</svg>${BAND[t]}</li>`).join("")
    + `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: 60, released: { at: "", kind: "seen" } }, 0)}</svg>approximate</li>`
    + `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: null, released: null }, 0)}</svg>not known</li>`;

  return `<!doctype html>
<html lang="en" data-id="${escape(id)}"${demo ? ` data-demo="${escape(demo.now)}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<title>${demo ? "Demo: " : ""}Package status · artcraft-nix</title>
<style>${minifyCss(STYLE)}</style>
</head>
<body>
<svg class="defs" aria-hidden="true" focusable="false"><defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="3" height="3"/><rect class="hatch-line" width="1.2" height="3"/></pattern></defs></svg>
<div class="page">
<header class="top">
<div class="title"><a class="brand" href="${repoUrl}">${MARK}<span>artcraft-nix</span></a><div class="crumb"><span class="slash" aria-hidden="true">/</span><h1>Package status</h1></div></div>
<nav aria-label="Project"><a href="${repoUrl}#quick-start">Install</a><a href="${repoUrl}/releases">Releases</a><a href="${repoUrl}">Repository</a></nav>
</header>
<main>
${demo ? demoBanner(demo) : ""}${hero(list, live, delivery, repo, target)}
${activity(list, live)}${sections}
</main>
<footer>
<h2 class="sr">About this page</h2>
<ul class="legend" aria-label="Delivery bands">${legend}</ul>
<p>Delivery is the time from upstream's release to the commit on <code>main</code>, for each version. The target is a median under ${escape(duration(target))}, over runs with no update run ahead of them and with runner queue time left out; the median over all releases is shown for information. The page is rebuilt every hour and on every update run; its data counts as out of date 2 hours after the last check.${live ? ` Last checked against upstream: <time id="checked-exact" datetime="${escape(live.checked)}">${escape(utc(live.checked))}</time>.` : ""}</p>
<p><a class="hit" href="${repoUrl}">artcraft-nix on GitHub</a> · <a class="hit" href="${repoUrl}/releases">its releases</a></p>
</footer>
</div>
<div class="tip" id="tip" aria-hidden="true"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---- Style -------------------------------------------------------------

/** Our own CSS, smaller on the wire: no comments, and no whitespace a rule
 * doesn't need (around { } ; , > and after :). Never a space before a ":",
 * which can be a descendant combinator. Only for STYLE, whose strings are
 * font names and empty contents (tests check). */
export function minifyCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").replace(/:\s+/g, ":")
    .replace(/;}/g, "}").trim();
}

/** Our own script, smaller on the wire: each line trimmed, comment lines
 * and blank lines dropped. Line breaks stay, so no statement runs into the
 * next. Only for SOURCE, which has no multi-line strings and no "//" in a
 * string (tests check). */
export function minifyJs(js: string): string {
  return js.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
}

export const STYLE = `
:root { color-scheme: light dark;
  --page: #F6F8FA; --surface: #FFFFFF; --hover: #F1F4F8; --text: #17202A; --muted: #526071; --link: #2457C5; --focus: #2457C5; --line: #DCE2E9;
  --ok: #17663F; --ok-bg: #EAF5EE; --move: #2457A7; --move-bg: #EDF3FF; --held: #815600; --held-bg: #FFF4D6; --none: #526071; --none-bg: #EEF1F5;
  --slow: #A52B32; --bad: #A52B32; --bad-bg: #FDECEE; --sample: #6A3FB5; --sample-bg: #F1EBFC; --approx: #7B8796; --flake: #4A78CF; --bolt: #FFD23F; --bolt-edge: #B87A00; }
@media (prefers-color-scheme: dark) { :root {
  --page: #10151D; --surface: #151B24; --hover: #1D2632; --text: #E8EDF4; --muted: #AAB6C7; --link: #9BBDFF; --focus: #9BBDFF; --line: #303B49;
  --ok: #88D9A6; --ok-bg: #172E23; --move: #A5C5FF; --move-bg: #1C2B43; --held: #F1CC75; --held-bg: #352B16; --none: #B7C2D1; --none-bg: #252E3A;
  --slow: #FFADB4; --bad: #FFADB4; --bad-bg: #3A1D22; --sample: #CDB6FF; --sample-bg: #2B2142; --approx: #69788D; --flake: #8FB2EE; --bolt-edge: #7A5200; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--text); font: 400 1rem/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
.defs { position: absolute; width: 0; height: 0; }
.page { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
strong { font-weight: 600; }
code { font: .875em/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
h1, h2, h3, h4, h5, p { margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); }
[hidden] { display: none !important; }

.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1.5rem; margin-bottom: 1.5rem; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .75rem; min-width: 0; }
.brand { display: inline-flex; align-items: center; gap: .625rem; color: var(--text); text-decoration: none; font-weight: 600; font-size: 1.25rem; line-height: 1.75rem; min-height: 2.75rem; }
/* The slash wraps with the heading, never left at the end of a line. */
.crumb { display: flex; align-items: center; gap: .75rem; }
.slash { color: var(--line); font-size: 1.5rem; font-weight: 300; }
.mark { width: 2.75rem; height: 2.75rem; flex: none; overflow: visible; }
.mark .flake path { fill: none; stroke: var(--flake); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
.mark .energy path { fill: none; stroke: #FFFFFF; stroke-width: 7; stroke-linecap: round; stroke-dasharray: 24 76; }
.mark .bolt { fill: var(--bolt); stroke: var(--page); stroke-width: 9; stroke-linejoin: round; paint-order: stroke; }
/* A dash of 200 then a gap of 210, starting 201 in: nothing drawn at the
   start (a zero-length dash would still draw its round cap). */
.mark .strike, .mark .glow { fill: none; stroke: var(--bolt); stroke-linecap: round; stroke-linejoin: round; opacity: 0; stroke-dasharray: 200 210; }
.mark .strike { stroke-width: 4; animation: mark-in 10s linear infinite; }
.mark .glow { stroke-width: 8.8; filter: url(#mark-blur); animation: mark-glow 10s linear infinite; }
.mark .spin, .mark .pop { transform-box: view-box; transform-origin: 50px 50px; }
.mark .spin { animation: mark-spin 10s cubic-bezier(.2, .9, .25, 1) infinite; }
.mark .pop { animation: mark-pop 10s cubic-bezier(.3, 1.6, .5, 1) infinite; }
.mark .energy { opacity: 0; animation: mark-energy 10s ease-out infinite; }
@keyframes mark-in { 0% { opacity: 1; stroke-dashoffset: 201; } 2.5% { opacity: 1; stroke-dashoffset: 0; } 4%, 100% { opacity: 0; stroke-dashoffset: 0; } }
@keyframes mark-glow { 0% { opacity: .9; stroke-dashoffset: 201; } 2.5% { opacity: .9; stroke-dashoffset: 0; } 4.5%, 100% { opacity: 0; stroke-dashoffset: 0; } }
@keyframes mark-pop { 0%, 2.6% { transform: scale(0); opacity: 0; } 2.8% { opacity: 1; } 4.5% { transform: scale(1.12); } 6%, 96% { transform: scale(1); opacity: 1; } 99.5%, 100% { transform: scale(0); opacity: 0; } }
@keyframes mark-spin { 0%, 2.5% { transform: rotate(0) scale(1); } 3% { transform: rotate(-6deg) scale(.92); } 6% { transform: rotate(60deg) scale(1.04); } 7.5%, 100% { transform: rotate(60deg) scale(1); } }
@keyframes mark-energy { 0%, 2.6% { opacity: 0; stroke-dashoffset: 24; } 2.8% { opacity: 1; } 6.5% { opacity: 1; stroke-dashoffset: -100; } 7%, 100% { opacity: 0; stroke-dashoffset: -100; } }
@media (prefers-reduced-motion: reduce) {
  .mark .strike, .mark .glow, .mark .spin, .mark .pop, .mark .energy { animation: none; }
}
nav { display: flex; flex-wrap: wrap; gap: .25rem; }
nav a { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 .75rem; border-radius: 6px; color: var(--text); text-decoration: none; font-weight: 500; font-size: 1rem; }
nav a:hover { background: var(--hover); }

h1 { font-size: 1.25rem; line-height: 1.75rem; font-weight: 500; color: var(--muted); }

.hero, .notice, .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.hero { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1.5rem 3rem; padding: 1.5rem; margin-bottom: 1rem; }
.hero-main { display: flex; gap: 1rem; align-items: flex-start; min-width: 0; flex: 1 1 24rem; }
.hero .lead { display: inline-flex; margin-top: .125rem; }
.hero .lead .st { width: 2rem; height: 2rem; stroke-width: 1.4; }
.hero-text { min-width: 0; }
#headline { font-size: 1.75rem; line-height: 2.25rem; font-weight: 600; letter-spacing: -.02em; }
.counts { display: flex; flex-wrap: wrap; align-items: center; column-gap: .375rem; row-gap: .25rem; margin-top: .5rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.count-item { display: inline-flex; align-items: center; gap: .375rem; color: var(--text); font-weight: 500; }
.latest { margin-top: .5rem; font-size: .875rem; line-height: 1.25rem; color: var(--muted); overflow-wrap: anywhere; }
.latest strong { color: var(--text); font-weight: 500; }
.note { margin-top: .5rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.status-line { display: flex; flex-wrap: wrap; align-items: center; row-gap: .25rem; margin-top: .75rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.status-line.is-stale .checked-text { color: var(--held); }
/* Each part spaces itself, so a hidden one leaves no gap. */
.checked-text, .live-status > span { margin-right: .75rem; }
.live-status { display: inline-flex; flex-wrap: wrap; }
.stale-note { display: inline-flex; color: var(--held); background: var(--held-bg); font-weight: 600; border-radius: 4px; padding: 0 .375rem; }
.figure { flex: 0 1 16rem; display: flex; flex-direction: column; justify-content: center; border-left: 1px solid var(--line); padding-left: 1.5rem; }
.figure-value { font-size: 1.75rem; line-height: 2.25rem; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.figure-label { font-size: .875rem; line-height: 1.25rem; font-weight: 500; }
.figure-met { margin-top: .375rem; font-size: .875rem; line-height: 1.25rem; }
.target { display: inline-flex; align-items: center; gap: .375rem; font-weight: 500; }
.target.ok { color: var(--ok); } .target.held { color: var(--held); }
.figure-sub { margin-top: .375rem; color: var(--muted); font-size: .8125rem; line-height: 1.25rem; }
/* A demo build's banner, and the tag on its sample rows. */
.demo { background: var(--sample-bg); border: 1px solid color-mix(in srgb, var(--sample) 40%, var(--line)); border-radius: 12px; padding: 1rem 1.5rem; margin-bottom: 1rem; display: grid; gap: .375rem; font-size: .875rem; line-height: 1.25rem; }
.demo h2 { display: flex; align-items: center; gap: .5rem; font-size: .9375rem; line-height: 1.5rem; font-weight: 600; color: var(--sample); }
.demo .tag { margin-left: 0; }
.tag.sample { color: var(--sample); background: var(--sample-bg); border-color: color-mix(in srgb, var(--sample) 45%, transparent); font-weight: 600; }

.notice { padding: 1rem 1.5rem; margin-bottom: 1rem; }
.notice h2 { font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
.notice ul { list-style: none; margin: .5rem 0 0; padding: 0; display: grid; gap: .5rem; }
.notice li { display: flex; gap: .5rem; align-items: flex-start; line-height: 1.5rem; }
.notice li .st { margin-top: .25rem; }
.attention { border-color: color-mix(in srgb, var(--held) 45%, var(--line)); background: color-mix(in srgb, var(--held-bg) 55%, var(--surface)); }
.attention h2 { color: var(--held); }

.group { margin-top: 2rem; }
.group > h2 { display: flex; align-items: center; gap: .5rem; font-size: 1.125rem; line-height: 1.5rem; font-weight: 600; margin-bottom: .75rem; }
.count { font-size: .75rem; line-height: 1rem; font-weight: 600; color: var(--muted); background: var(--none-bg); border-radius: 999px; padding: .125rem .5rem; font-variant-numeric: tabular-nums; }
.card { overflow: hidden; }
.card-note { padding: 1rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; border-bottom: 1px solid var(--line); }
.card-note:last-child { border-bottom: 0; }
/* A companion, under its app: a line down the left joins it to the app's
   row. It sits in the row's own padding, with its content indented past it:
   the whole row on narrow screens, and on wide ones the name and the details
   only, so the columns stay under the header row's. */
.sub-pkg { border-top: 0; }
.sub-pkg::after { content: ""; position: absolute; top: 0; bottom: 0; left: 1rem; border-left: 2px solid var(--line); }
.sub-pkg .pkg-name { font-weight: 500; }

.pkgs { list-style: none; margin: 0; padding: 0; }
.pkg { position: relative; padding: 1rem; border-top: 1px solid var(--line); transition: background-color .12s; }
.cols + .pkgs > .pkg:first-child { border-top: 0; }
.pkg:hover, .pkg:focus-within { background: var(--hover); }
.cols { display: none; }
.cell { min-width: 0; font-size: .875rem; line-height: 1.25rem; }
.who { font-size: 1rem; line-height: 1.5rem; }
.pkg-name { display: inline; font-size: 1rem; line-height: 1.5rem; font-weight: 600; }
.attr { color: var(--muted); font-size: .8125rem; margin-left: .25rem; overflow-wrap: anywhere; }
.tag { display: inline-block; margin-left: .375rem; font-size: .75rem; line-height: 1rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 .375rem; vertical-align: 1px; }
.desc { color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.state { display: flex; align-items: flex-start; }
.state > span, .state-words > span, .notice li > span, .more-body dd { min-width: 0; overflow-wrap: anywhere; }
/* Links in rows and cards: a target at least 24px tall, 4px taller than its
   line, without moving the text. They don't overlap the next line's only
   because rows, the meta line and the notice lists keep at least 8px
   between lines (WCAG 2.5.8): keep that gap wherever two of them can sit on
   adjacent lines. */
a.hit { display: inline-block; padding-block: .125rem; margin-block: -.125rem; }
/* The state as a tinted pill, its icon inside, in the state's own colour;
   the versions on main no longer share it. The edge, a faint mix of the
   pill's colour, keeps the pill's shape on a hovered row (whose background
   is as light as the tints) and becomes an outline in forced colours. */
.state-words, .reason { display: inline-flex; align-items: flex-start; gap: .375rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .75rem; padding: 0 .5rem; font-weight: 500; }
.state-words .st { margin-top: .125rem; }
.state.ok .state-words { color: var(--ok); background: var(--ok-bg); }
.state.found .state-words, .state.back .state-words, .state.testing .state-words, .state.wait .state-words { color: var(--move); background: var(--move-bg); }
.state.held .state-words { color: var(--held); background: var(--held-bg); }
.state.gone .state-words { color: var(--bad); background: var(--bad-bg); }
.state.none .state-words, .reason { color: var(--muted); background: var(--none-bg); }
.reason { font-size: .8125rem; }
.state a { color: inherit; }
.sub { display: block; color: var(--muted); font-size: .8125rem; }
.v { font-variant-numeric: tabular-nums; }
/* Versions on main read as text, not as a state: their link shows by a
   full-strength underline in --muted (3:1 on the row in both schemes). A
   state's link, in its pill, underlines in the pill's own colour. */
.ver a { color: var(--text); text-decoration-color: var(--muted); }
.ver a:hover { text-decoration-color: currentColor; }
.state-words a { text-decoration-color: currentColor; }
.state-words a:hover { text-decoration-thickness: 2px; }
.ver, .dlv { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
/* The bolt (the end of SCRIPT): lightning drawn over the On main column,
   clipped to it, onto each version changed since the reader last saw it; the
   version flashes and keeps a small bolt for as long as the page is open. */
.zap { position: absolute; pointer-events: none; overflow: visible; z-index: 20; }
.zap path, .zap line { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.zap .edge { stroke: var(--bolt-edge); stroke-width: 5; }
.zap .glow { stroke: var(--bolt); stroke-width: 11; filter: url(#mark-blur); opacity: .75; }
.zap .main { stroke: var(--bolt); stroke-width: 3; }
.zap .core { stroke: #FFFFFF; stroke-width: 1.2; }
.zap .spark { stroke: var(--bolt); stroke-width: 2; }
.zap .halo { fill: var(--bolt); filter: url(#mark-blur); }
.zapped .ver { animation: zap-text 1.4s cubic-bezier(.2, .8, .3, 1); }
@keyframes zap-text {
  0% { text-shadow: 0 0 2px #FFFFFF, 0 0 10px var(--bolt), 0 0 22px var(--bolt); transform: translateX(0); }
  4% { transform: translateX(-2px); } 8% { transform: translateX(2px); } 12% { transform: translateX(-1px); } 16% { transform: translateX(0); }
  100% { text-shadow: 0 0 0 transparent; } }
.zap-tag { display: inline-flex; vertical-align: -2px; margin-left: .375rem; width: .875rem; height: .875rem; }
.zap-tag svg { width: 100%; height: 100%; overflow: visible; }
.zap-tag path { fill: var(--bolt); stroke: var(--bolt-edge); stroke-width: 6; stroke-linejoin: round; paint-order: stroke; }
.zap-tag.pop { animation: zap-pop .55s cubic-bezier(.3, 1.8, .5, 1) both; }
@keyframes zap-pop { 0% { transform: scale(0) rotate(-25deg); opacity: 0; } 100% { transform: scale(1) rotate(0); opacity: 1; } }
.dlv { display: flex; align-items: center; gap: .375rem; white-space: nowrap; }
/* A chip may wrap rather than spill into the next column. */
.dlv .reason { white-space: normal; }
.none-text { color: var(--muted); }
.band-mark { width: 6px; height: 16px; flex: none; }
.strip { display: block; overflow: visible; }
.strip .hit { fill: transparent; }
/* The bar under the pointer grows, springing up from its base. */
.strip g > :not(.hit) { transform-box: fill-box; transform-origin: 50% 100%; transition: transform .2s cubic-bezier(.3, 1.8, .5, 1), filter .2s; }
.strip g.on > :not(.hit) { transform: scale(1.5, 1.35); filter: drop-shadow(0 1px 2px rgb(0 0 0 / .35)); }
.tip { position: fixed; left: 0; top: 0; z-index: 10; pointer-events: none; min-width: 13rem; max-width: min(21rem, calc(100vw - 1rem)); padding: .625rem .75rem;
  background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: .625rem; box-shadow: 0 10px 28px rgb(0 0 0 / .22), 0 2px 6px rgb(0 0 0 / .1);
  font-size: .8125rem; line-height: 1.4; visibility: hidden; opacity: 0; transform: translateY(6px) scale(.94); transform-origin: var(--ax, 50%) 100%;
  transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s .14s; }
.tip.below { transform: translateY(-6px) scale(.94); transform-origin: var(--ax, 50%) 0; }
.tip.show { visibility: visible; opacity: 1; transform: none; transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s; }
.tip.show.glide { transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s, left .14s ease-out, top .14s ease-out; }
.tip::after { content: ""; position: absolute; left: var(--ax, 50%); bottom: -6px; width: 10px; height: 10px; margin-left: -5px; background: var(--surface);
  border: solid var(--line); border-width: 0 1px 1px 0; transform: rotate(45deg); }
.tip.below::after { bottom: auto; top: -6px; border-width: 1px 0 0 1px; }
.tip-head { display: flex; align-items: center; gap: .5rem; }
.tip-v { font: 600 .8125rem/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; overflow-wrap: anywhere; }
.tip-tag { margin-left: auto; flex: none; padding: 0 .4rem; border-radius: 999px; background: var(--move-bg); color: var(--move); font-size: .6875rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.tip-d { display: flex; align-items: baseline; gap: .375rem; margin-top: .375rem; }
.tip-d strong { font-size: 1.0625rem; }
.tip-note, .tip-t { color: var(--muted); }
.tip-dot { width: .625rem; height: .625rem; flex: none; align-self: center; border-radius: 2px; }
.tip-dot.good { background: var(--ok); } .tip-dot.fair { background: var(--held); } .tip-dot.slow { background: var(--slow); }
.tip-dot.approx { background: repeating-linear-gradient(45deg, var(--approx) 0 1px, transparent 1px 3px); border: 1px solid var(--approx); } .tip-dot.none { border: 1.5px solid var(--approx); border-radius: 50%; }
.tip-t { margin-top: .125rem; font-size: .75rem; }

.st { width: 1rem; height: 1rem; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.st.ok { color: var(--ok); } .st.found, .st.back, .st.testing, .st.wait { color: var(--move); } .st.held, .st.stale { color: var(--held); } .st.gone { color: var(--bad); } .st.none { color: var(--none); }
.b-good { fill: var(--ok); } .b-fair { fill: var(--held); } .b-slow { fill: var(--slow); }
.b-approx { fill: url(#hatch); stroke: var(--approx); stroke-width: 1; }
.hatch-bg { fill: var(--surface); } .hatch-line { fill: var(--approx); }
.b-none { fill: none; stroke: var(--approx); stroke-width: 1.2; }

.more { margin-top: .5rem; }
.more > summary { display: inline-flex; align-items: center; gap: .25rem; min-height: 2.75rem; cursor: pointer; color: var(--link); font-size: .875rem; font-weight: 500; list-style: none; }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::after { content: ""; width: .375rem; height: .375rem; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: translateY(-2px) rotate(45deg); transition: transform .12s; }
.more[open] > summary::after { transform: translateY(1px) rotate(-135deg); }
.more-body { padding: .5rem 0 .25rem; font-size: .875rem; line-height: 1.25rem; display: grid; gap: .75rem; }
.more-body dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
.more-body dt { color: var(--muted); }
.more-body dd { margin: 0; }
.hist-title { font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
.hist { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
.hist li { display: flex; flex-wrap: wrap; gap: 0 .75rem; font-variant-numeric: tabular-nums; }
.hist .v { min-width: 6rem; font-weight: 500; overflow-wrap: anywhere; }

footer { margin-top: 3rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; display: grid; gap: .75rem; }
.legend { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; list-style: none; margin: 0; padding: 0; }
.legend li { display: inline-flex; align-items: center; gap: .375rem; }

/* Wide screens: the rows line up in columns, the details' summary in the
   last one and its panel across the row under it. */
@media (min-width: 60rem) {
  .meta { display: contents; }
  /* The Electron line under the row's values, between the name and Details. */
  .sub-pkg .who, .sub-pkg .more-body { padding-left: .875rem; }
  .cols, .pkg { display: grid; grid-template-columns: minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.2fr) minmax(0, .9fr) 7.5rem 5.5rem; column-gap: 1rem; align-items: start; }
  .cols.no-state, .no-state ~ .pkgs .pkg { grid-template-columns: minmax(0, 2.6fr) minmax(0, 1.4fr) minmax(0, 1fr) 7.5rem 5.5rem; }
  .cols { padding: .625rem 1rem; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
  .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .recent { padding-top: .125rem; }
  .more { grid-column: 1 / -1; margin: 0; }
  .more > summary { position: absolute; top: .375rem; right: 1rem; }
  .more[open] > .more-body { margin-top: .75rem; padding-top: .75rem; border-top: 1px dashed var(--line); }
}
/* Narrow screens: each row stacks, with its labels shown. */
@media (max-width: 59.99rem) {
  .page { padding: 1rem 1rem 3rem; }
  #headline, .figure-value { font-size: 1.5rem; line-height: 2rem; }
  .figure { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: 1rem; flex-basis: 100%; }
  /* The same lines in every row: the name (with its description), the
     state, then On main, Delivery and the strip (the strip on a line of its
     own when they don't fit), then Details. */
  .pkg { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: .5rem; padding: .75rem 1rem .25rem; }
  .sub-pkg { padding-left: 1.875rem; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
  .lbl { color: var(--muted); }
  .state .lbl, .recent .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .more { margin: 0; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } .zapped .ver, .zap-tag.pop { animation: none; } }
@media (forced-colors: active) {
  .st { color: CanvasText; }
  .b-good, .b-fair, .b-slow { fill: CanvasText; }
  .b-approx { stroke: CanvasText; } .hatch-line { fill: CanvasText; } .hatch-bg { fill: Canvas; }
  .b-none { stroke: CanvasText; }
  .mark .flake path { stroke: CanvasText; } .mark .bolt { fill: CanvasText; stroke: Canvas; } .mark .strike, .mark .glow, .mark .energy { display: none; }
  .zap { display: none; } .zap-tag path { fill: CanvasText; stroke: Canvas; }
}
`;

// ---- Script ------------------------------------------------------------

// Nothing changes by itself while someone is in the window, except the
// out-of-date switch turning on, a reload for newer data and the bolt (at
// the end of the script, with its own comment). "Nobody in the
// window": the tab hidden, or the window unfocused for 2 minutes (a moment
// in the find bar doesn't count). Then, once a minute, the relative times
// are redrawn with the newest check time, and once more when someone comes
// back. Checks of the site's tiny live.json, only while the tab is
// visible: on start, on becoming visible, and once a minute (not within
// 30 s of the last); one at a time, aborted after 15 s. The same id: only
// the check time is taken. Another id: a reload at once (an answer that
// arrives while the tab is hidden waits for the check on becoming
// visible). Each id gets at most 3 reloads in an hour, 10 minutes apart: a
// cache that still serves the old page gets another chance, and data that
// comes back to an earlier id later is reloaded for again. Times are
// compared either way round, so a clock set back can't stop checks or
// tries. The tab remembers its tries, and its own id as
// one; if storage can't be trusted, it never reloads by itself.
const SOURCE = `// Told whether the page is current (see the bolt, below): true after a
// check of live.json that started since the tab last came back and didn't
// reload, false when it reloads.
let pageState = () => {};
(() => {
  const d = document, id = d.documentElement.dataset.id, demo = d.documentElement.dataset.demo;
  const $ = (q) => d.querySelector(q), all = (q) => d.querySelectorAll(q);
  const IDS = "artcraft-nix-reloaded";
  // Storage that can't be read or written, or doesn't keep what it was
  // given, turns the automatic reload off for this tab.
  let broken = false;
  const get = () => { try { return sessionStorage.getItem(IDS); } catch { broken = true; return null; } };
  const remembered = () => { try { const a = JSON.parse(get() || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  // Tries are "<id>@<ms>"; a bare "<id>" (an older page's) is a try long
  // ago, so aged out.
  const tries = (x) => remembered().filter((e) => typeof e === "string" && (e === x || e.startsWith(x + "@")))
    .map((e) => Number(e.slice(x.length + 1)) || 0);
  const remember = (x) => {
    const e = x + "@" + Date.now();
    try { sessionStorage.setItem(IDS, JSON.stringify([...remembered(), e].slice(-20))); } catch { broken = true; }
    if (!remembered().includes(e)) broken = true;
  };
  const f = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const units = [["year", 31536e3], ["month", 2592e3], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  // returns: how often the tab has come back, so a check that started
  // before can't say the page is current; leaving: a reload has started,
  // and no check after that says the page is current.
  // A demo build reads its times against its own clock, and checks nothing.
let skew = demo && Number.isFinite(Date.parse(demo)) ? Date.parse(demo) - Date.now() : 0, busy = false, lastCheck = 0, stale = false, first = true, returns = 0, leaving = false;
  const now = () => Date.now() + skew;
  // hasFocus() too, so a missed focus event can't leave a reader "away".
  const hasFocus = () => typeof d.hasFocus !== "function" || d.hasFocus();
  let blurredAt = hasFocus() ? null : Date.now();
  const away = () => d.hidden || (!hasFocus() && blurredAt !== null && Date.now() - blurredAt >= 120e3);
  const ago = (iso) => {
    const s = (now() - Date.parse(iso)) / 1000;
    // Under a minute, or ahead of us, is "just now"; whole units, rounded down.
    if (!(s >= 60)) return "just now";
    const [unit, n] = units.find(([, n]) => s >= n);
    return f.format(-Math.floor(s / n), unit);
  };
  const utc = (iso) => {
    const t = new Date(iso), two = (n) => String(n).padStart(2, "0");
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return t.getUTCDate() + " " + M[t.getUTCMonth()] + " " + t.getUTCFullYear() + ", " + two(t.getUTCHours()) + ":" + two(t.getUTCMinutes()) + " UTC";
  };
  // Exact times in the reader's own time zone, in the page's English: the
  // date as the page writes it, the clock as the reader's English locale
  // writes it, or else British English with the reader's 12- or 24-hour
  // clock ("13 Nov 2026, 3:50 PM EST", "13 Nov 2026, 17:50 CET"). Without
  // Intl, UTC as the page was built.
  const local = (() => {
    try {
      const own = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
      const english = /^en(-|$)/i.test(own.locale);
      const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", year: "numeric" });
      const clock = new Intl.DateTimeFormat(english ? own.locale : "en-GB",
        { hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(english || !own.hourCycle ? {} : { hourCycle: own.hourCycle }) });
      const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const f = (iso) => {
        const t = new Date(iso), p = {};
        for (const x of date.formatToParts(t)) p[x.type] = x.value;
        return Number(p.day) + " " + M[Number(p.month) - 1] + " " + p.year + ", " + clock.format(t);
      };
      f(new Date(0).toISOString());
      return f;
    } catch { return null; }
  })();
  const exact = local || utc;
  const checkedEl = $("#checked");
  // The newest check time this tab knows; the page shows it at redraws.
  let checked = checkedEl ? checkedEl.dateTime : null;
  const show = (el, on) => { if (el && el.hidden === on) el.hidden = !on; };
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setStale = (on) => {
    stale = on;
    for (const q of [".stale-note", ".at-last", ".stale-icon"]) show($(q), on);
    for (const el of all(".lead:not(.stale-icon)")) show(el, !on);
    const line = $(".status-line");
    if (line) line.classList.toggle("is-stale", on);
  };
  const isStale = () => checked !== null && now() - Date.parse(checked) > 120 * 60e3;
  // Everything, as of now: the check time, every relative time, the switch.
  const redraw = () => {
    if (checkedEl && checked && checkedEl.dateTime !== checked) {
      checkedEl.dateTime = checked;
      checkedEl.title = exact(checked);
      const foot = $("#checked-exact");
      if (foot) { foot.dateTime = checked; setText(foot, exact(checked)); }
    }
    for (const t of all("time.rel")) setText(t, ago(t.dateTime));
    if (isStale() !== stale) setStale(!stale);
  };
  // While someone reads: the switch may only turn on, with the checked
  // line's own words, so it never says "1 hour ago" beside "Out of date".
  const settle = () => {
    if (away()) return redraw();
    if (!stale && isStale()) {
      if (checkedEl) setText(checkedEl, ago(checkedEl.dateTime));
      setStale(true);
    }
  };
  const since = (t) => Math.abs(Date.now() - t);
  const reload = (x) => {
    const t = tries(x).filter((at) => since(at) < 3600e3);
    if (broken || t.length >= 3 || t.some((at) => since(at) < 10 * 60e3)) return;
    remember(x);
    if (broken) return;
    leaving = true;
    pageState(false);
    location.reload();
  };
  const check = async () => {
    if (demo) {
      if (first) { first = false; redraw(); } else settle();
      if (!d.hidden) pageState(true);
      return;
    }
    if (busy) return;
    busy = true;
    lastCheck = Date.now();
    const back = returns;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15e3) : null;
    try {
      const res = await fetch("live.json?t=" + Date.now(), { cache: "no-store", ...(ctrl ? { signal: ctrl.signal } : {}) });
      const server = Date.parse(res.headers.get("date"));
      if (Number.isFinite(server)) skew = server - Date.now();
      const data = await res.json();
      if (typeof data.id !== "string") return;
      if (data.id === id) {
        const c = data.checked;
        if (checkedEl && typeof c === "string" && Number.isFinite(Date.parse(c)) && (checked === null || Date.parse(c) > Date.parse(checked))) checked = c;
      } else if (!d.hidden) reload(data.id);
    } catch {} finally {
      if (timer) clearTimeout(timer);
      busy = false;
      // The first check, part of loading the page, and the check on coming
      // back to the tab (it may have been frozen for hours) draw everything,
      // with the clock the Date header corrected.
      if (first) { first = false; redraw(); } else settle();
      // Not reloading: as current as it can be, for now. Unless the tab came
      // back while this was out, which skipped the return's own check: that
      // check runs now, and draws everything as a return's check does.
      if (!leaving && !d.hidden) { if (back === returns) pageState(true); else { first = true; check(); } }
    }
  };
  // Once, on start: every exact time, and the exact time each relative one
  // shows on hover, in the reader's zone.
  if (local) {
    for (const t of all("time:not(.rel)")) setText(t, exact(t.dateTime));
    for (const t of all("time.rel")) t.title = exact(t.dateTime);
  }
  // The strip's card: the bar under the pointer (or tapped) grows, and a
  // card over it shows that delivery; moving along the strip slides the
  // card from bar to bar. A tap elsewhere, a scroll, a resize or Escape
  // closes it. The details list has the same, for keyboards and screen
  // readers.
  const tip = $("#tip");
  if (tip) {
    let on = null;
    const add = (tag, cls, parent, text) => {
      const e = d.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      parent.appendChild(e);
      return e;
    };
    const barOf = (t) => (t && t.closest ? t.closest(".strip g[data-at]") : null);
    const hide = () => {
      if (on) on.classList.remove("on");
      on = null;
      tip.classList.remove("show");
    };
    const show = (g) => {
      if (g === on) return;
      if (on) on.classList.remove("on");
      on = g;
      g.classList.add("on");
      const at = g.getAttribute("data-at");
      tip.textContent = "";
      const head = add("div", "tip-head", tip);
      add("span", "tip-v", head, g.getAttribute("data-v"));
      if (g === g.parentNode.lastElementChild) add("span", "tip-tag", head, "Latest");
      const took = add("div", "tip-d", tip);
      add("span", "tip-dot " + g.getAttribute("data-band"), took);
      add("strong", "", took, g.getAttribute("data-d"));
      add("span", "tip-note", took, g.getAttribute("data-note"));
      add("div", "tip-t", tip, "Published " + ago(at) + " \u00b7 " + exact(at));
      // Over the bar, or under it when there's no room; inside the window.
      // It glides only from another bar, never in from where it last was.
      tip.classList.toggle("glide", tip.classList.contains("show"));
      const b = g.querySelector(".hit").getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight, vw = d.documentElement.clientWidth;
      const cx = b.left + b.width / 2, left = Math.min(Math.max(8, cx - w / 2), vw - w - 8);
      const below = b.top - h - 12 < 8;
      tip.classList.toggle("below", below);
      tip.style.left = left + "px";
      tip.style.top = (below ? b.bottom + 12 : b.top - h - 12) + "px";
      tip.style.setProperty("--ax", cx - left + "px");
      tip.classList.add("show");
    };
    d.addEventListener("pointerover", (e) => { const g = barOf(e.target); if (g) show(g); });
    // A mouse leaving the bar closes the card, unless it went to another
    // bar; a touch keeps it open until the next tap.
    d.addEventListener("pointerout", (e) => {
      if (on && e.pointerType !== "touch" && barOf(e.target) === on && !barOf(e.relatedTarget)) hide();
    });
    d.addEventListener("pointerdown", (e) => { if (!barOf(e.target)) hide(); });
    d.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    addEventListener("scroll", hide, { passive: true });
    addEventListener("resize", hide);
  }
  // This page's own id counts as a try.
  if (id && !tries(id).length) remember(id);
  addEventListener("blur", () => { blurredAt = Date.now(); });
  addEventListener("focus", () => {
    const back = blurredAt !== null && Date.now() - blurredAt >= 120e3;
    blurredAt = null;
    if (back) redraw();
  });
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) return;
    returns++;
    redraw();
    first = true;
    check();
  });
  redraw();
  if (!d.hidden) check();
  setInterval(() => {
    // A check settles when it ends; without one (or with one still out),
    // settle now. (After a sleep, settling before the check would show
    // "Out of date" for data the check is about to refresh.)
    if (!busy && !d.hidden && since(lastCheck) >= 30e3) check(); else settle();
  }, 60e3);
})();
// The bolt: versions changed since this reader last saw them. Each row
// carries its version (data-v). The tab keeps the versions it has shown
// in sessionStorage, the browser the newest any tab has shown in
// localStorage; a page compares with the tab's own, else the browser's.
// A row that didn't change (or is new to the page) is remembered at once;
// a changed one gets the small bolt at once, and is remembered only when
// it has been seen (fully in view, the tab visible and the page current),
// and then gets its strike. So a reload before the reader scrolls to it, or
// a tab that loads hidden, loses nothing, and a tab never strikes the same
// version twice. The strike: from the On main heading onto the first
// version in view, then chain lightning down the column to the others in
// view in the same card, clipped to the column (on narrow screens, where
// the layout hides the heading, sparks on each version alone). No bolt at all on a
// first visit or when storage can't be read. Reduced motion, forced
// colours or no Web Animations: the small bolt, no strike. No
// IntersectionObserver: the small bolt, remembered at once.
(() => {
  const d = document, KEY = "artcraft-nix-seen";
  const rows = Array.from(d.querySelectorAll(".pkg[data-v]"));
  if (!rows.length) return;
  const name = (r) => r.id.slice(4);
  let stores;
  try { stores = [sessionStorage, localStorage]; } catch { return; }
  const read = (s) => { try { const m = JSON.parse(s.getItem(KEY) || "null"); return m && typeof m === "object" && !Array.isArray(m) ? m : null; } catch { return null; } };
  const base = read(stores[0]) || read(stores[1]);
  const remember = (list) => {
    for (const s of stores) {
      try {
        const m = read(s) || Object.assign({}, base);
        for (const r of list) m[name(r)] = r.dataset.v;
        s.setItem(KEY, JSON.stringify(m));
      } catch {}
    }
  };
  const fresh = base ? rows.filter((r) => typeof base[name(r)] === "string" && base[name(r)] !== r.dataset.v) : [];
  remember(rows.filter((r) => !fresh.includes(r)));
  if (!fresh.length) return;
  // The SVG namespace, from the mark: SOURCE has no "//" in a string (see
  // minifyJs), and the namespace's URL would be one.
  const NS = d.querySelector(".mark").namespaceURI;
  const el = (n, a, p) => { const e = d.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const cell = (r) => r.querySelector(".cell.ver");
  const media = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
  const still = () => media("(prefers-reduced-motion: reduce)") || media("(forced-colors: active)") || typeof d.body.animate !== "function";
  // The small bolt, said as "changed since your last visit".
  for (const r of fresh) {
    const tag = d.createElement("span");
    tag.className = "zap-tag";
    tag.title = "Changed since your last visit";
    el("path", { d: "M62 6 35 53H50L40 94 68 44H53Z" }, el("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" }, tag));
    const sr = tag.appendChild(d.createElement("span"));
    sr.className = "sr";
    sr.textContent = ", changed since your last visit";
    cell(r).appendChild(tag);
  }
  if (typeof IntersectionObserver !== "function") return remember(fresh);
  // A jagged line from a to b (midpoint displacement), kept between x0 and x1.
  const jag = (a, b, rough, x0, x1) => {
    let pts = [a, b], w = rough;
    for (let i = 0; i < 5; i++, w *= .55) {
      const out = [pts[0]];
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j - 1], q = pts[j], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1, o = (Math.random() - .5) * w;
        out.push([(p[0] + q[0]) / 2 - dy / len * o, (p[1] + q[1]) / 2 + dx / len * o], q);
      }
      pts = out;
    }
    return pts.map((p) => [Math.min(x1 - 4, Math.max(x0 + 4, p[0])), p[1]]);
  };
  const path = (pts) => "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L");
  const play = (e, k, o) => e.animate(k, Object.assign({ fill: "forwards" }, o));
  // One bolt in layer g, drawn in and flickering out; returns when it lands.
  const bolt = (g, a, b, box, o) => {
    const sub = el("g", { opacity: o.alpha }, g), dd = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pts = jag(a, b, Math.min(o.rough * dd, (box.r - box.l) * .55), box.l, box.r), lines = [];
    const draw = (pp, thin) => ["edge", "glow", "main", "core"].map((c) => {
      const p = el("path", { class: c, d: path(pp) }, sub);
      if (thin) p.style.strokeWidth = "calc(" + getComputedStyle(p).strokeWidth + " * .55)";
      return p;
    });
    lines.push(...draw(pts, false));
    for (let i = 0; i < o.branches; i++) {
      const at = pts[Math.floor(pts.length * (.3 + Math.random() * .4))];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + (Math.random() < .5 ? -1 : 1) * (.45 + Math.random() * .5);
      const len = dd * (.18 + Math.random() * .22);
      lines.push(...draw(jag(at, [at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len], len * .5, box.l, box.r), true));
    }
    for (const p of lines) {
      const L = p.getTotalLength();
      p.style.strokeDasharray = L;
      p.style.strokeDashoffset = L;
      play(p, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 90, delay: o.delay, easing: "ease-in" });
    }
    play(sub, [{ opacity: o.alpha }, { opacity: o.alpha, offset: .2 }, { opacity: .2, offset: .3 }, { opacity: o.alpha, offset: .4 }, { opacity: .5, offset: .65 }, { opacity: 0 }], { duration: 520, delay: o.delay + 90 });
    return o.delay + 90;
  };
  // Where a bolt lands: on top of the version, a little way in.
  const spot = (r) => {
    const c = cell(r), lbl = c.querySelector(".lbl"), range = d.createRange();
    range.setStart(c, lbl ? Array.prototype.indexOf.call(c.childNodes, lbl) + 1 : 0);
    range.setEnd(c, c.childNodes.length);
    const b = range.getClientRects()[0] || c.getBoundingClientRect();
    return [b.left + Math.min(b.width * .4, 22), b.top + 3];
  };
  // Where a strike lands: sparks and a halo, the version flashing and its
  // small bolt popping.
  const land = (r, g, p) => {
    const halo = el("circle", { class: "halo", cx: p[0], cy: p[1], r: 4 }, g);
    play(halo, [{ r: 4, opacity: .95 }, { r: 26, opacity: 0 }], { duration: 420, easing: "ease-out" });
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * i / 4 + Math.random() * .5, far = 12 + Math.random() * 14;
      const s = el("line", { class: "spark", x1: p[0] + Math.cos(a) * 4, y1: p[1] + Math.sin(a) * 4, x2: p[0] + Math.cos(a) * 9, y2: p[1] + Math.sin(a) * 9 }, g);
      play(s, [{ transform: "translate(0,0)", opacity: 1 }, { transform: "translate(" + Math.cos(a) * far + "px," + (Math.sin(a) * far + 6) + "px)", opacity: 0 }], { duration: 380 + Math.random() * 200, easing: "cubic-bezier(.1,.7,.3,1)" });
    }
    r.classList.add("zapped");
    cell(r).querySelector(".zap-tag").classList.add("pop");
  };
  // One layer per strike over the window as it is, scrolling with the page,
  // clipped to the column (or the version). clientWidth leaves out
  // a scrollbar, so the layer never widens the page.
  const layer = (box) => {
    const w = d.documentElement.clientWidth, h = d.documentElement.clientHeight;
    const g = el("svg", { class: "zap", "aria-hidden": "true", viewBox: "0 0 " + w + " " + h }, d.body);
    const px = (n) => Math.max(0, n) + "px";
    Object.assign(g.style, { left: scrollX + "px", top: scrollY + "px", width: w + "px", height: h + "px",
      clipPath: "inset(" + px(box.t) + " " + px(w - box.r) + " " + px(h - box.b) + " " + px(box.l) + ")" });
    return g;
  };
  // The rows of one card that came into view together, top to bottom: a
  // chain down the column from its heading, or on narrow screens (where
  // the layout hides the heading) the landing alone on each version, one
  // after another.
  const strike = (group) => {
    const card = group[0].closest(".card"), head = card.querySelector(".col-ver");
    const hop = group.length > 5 ? 110 : 170;
    if (!head || !head.getClientRects().length) {
      group.forEach((r, i) => {
        setTimeout(() => {
          const vb = cell(r).getBoundingClientRect(), g = layer({ l: vb.left - 8, r: vb.right, t: vb.top - 8, b: vb.bottom + 8 });
          land(r, g, spot(r));
          setTimeout(() => g.remove(), 1200);
        }, i * hop);
      });
      return;
    }
    const hb = head.getBoundingClientRect(), box = { l: hb.left - 8, r: hb.right, t: hb.bottom + 2, b: card.getBoundingClientRect().bottom };
    const g = layer(box);
    let t = 0, last = null;
    group.forEach((r, i) => {
      const p = spot(r);
      const from = last || [(box.l + box.r) / 2 + (Math.random() - .5) * (box.r - box.l) * .3, box.t];
      t = bolt(g, from, p, box, { rough: last ? .5 : .35, alpha: last ? .85 : 1, delay: i ? t + hop - 90 : 0, branches: last ? 1 : 3 });
      setTimeout(() => land(r, g, p), t);
      last = p;
    });
    setTimeout(() => g.remove(), t + 1200);
  };
  // Each changed version once it is fully in view, with the tab visible
  // and the page current (pageState): the gate opens with the first check
  // of live.json that says so, and again with the first after the tab
  // comes back, and each time it opens it looks afresh at those it hasn't
  // struck. Hidden, or once a reload has started, it waits. So a page that
  // is reloading for newer data starts no strike and remembers nothing.
  const waiting = new Set(fresh);
  let current = false;
  d.addEventListener("visibilitychange", () => { if (d.hidden) current = false; });
  const io = new IntersectionObserver((es) => {
    if (d.hidden || !current) return;
    const full = new Map();
    for (const e of es) full.set(e.target, e.isIntersecting && e.intersectionRatio >= .99);
    const now = fresh.filter((r) => waiting.has(r) && full.get(cell(r)));
    const cards = new Map();
    for (const r of now) {
      waiting.delete(r);
      io.unobserve(cell(r));
      const c = r.closest(".card");
      cards.set(c, (cards.get(c) || []).concat(r));
    }
    if (!now.length) return;
    // Seen now, so remembered now; the strike that follows only shows it.
    remember(now);
    if (!still()) cards.forEach(strike);
  }, { threshold: [0, .99] });
  pageState = (on) => {
    if (on === current) return;
    current = on;
    if (!on) return;
    // Opening: reports queued while it was shut may be out of date, so
    // they're dropped, and a fresh one asked for.
    io.takeRecords();
    for (const r of waiting) { io.unobserve(cell(r)); io.observe(cell(r)); }
  };
})();`;
/** The script as the page carries it (minifyJs). */
export const SCRIPT = minifyJs(SOURCE);
/** The script's hash, for the Content-Security-Policy. */
export const SCRIPT_HASH = `sha256-${createHash("sha256").update(SCRIPT).digest("base64")}`;

if (import.meta.main) {
  // The offline build: the same command line as status.ts's. Not awaited:
  // status.ts imports this file, which must finish evaluating first.
  void import("./status.ts").then(({ main }) => main(process.argv.slice(2)));
}
