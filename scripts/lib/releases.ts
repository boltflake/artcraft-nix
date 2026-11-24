// This repo's releases. Differs from t3code-nix, which makes one per T3 Code
// desktop version: here every publish that changes an app's version gets one,
// named YYYY.MM.DD.N.
//
// - The date is UTC, taken when publish allocates the name.
// - N is one more than the highest N for that date among the release
//   trailers on the recorded base's first-parent history and the
//   release-name tags on the remote (a stray tag's name is skipped). A
//   publish that re-dispatches because main moved allocates again on the
//   new base, and publishes run one at a time, so two can't take the same N.
// - The name goes in the commit as a trailer and is pushed as a tag with
//   the commit. Hand commits never carry one; reconcile rebuilds missing tags
//   and GitHub Releases from the trailers, in history order.
import { compareVersions, OWNER, releasePage, SOURCES } from "../../shared/sources.ts";
import { tryRun, type Pin } from "./util.ts";

export const TRAILER = "Artcraft-Release";
const NAME = /^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d*)$/;

export const dateOf = (now: Date) => now.toISOString().slice(0, 10).replaceAll("-", ".");
export const isName = (s: string) => NAME.test(s);

/** The trailer's value in a commit message, or null. */
export function trailerOf(message: string): string | null {
  const lines = message.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && lines[i].trim() !== ""; i--) {
    const m = new RegExp(`^${TRAILER}: (\\S+)$`).exec(lines[i]);
    if (m && isName(m[1])) return m[1];
  }
  return null;
}

/** The next name for `now`, given the names already taken: the trailers on
 * the base's first-parent history and the remote's release-name tags. */
export function allocate(trailers: string[], now: Date): string {
  const date = dateOf(now);
  // BigInt: a hand-made tag with a huge suffix still gets one past it.
  let n = 0n;
  for (const t of trailers) {
    const m = NAME.exec(t);
    if (m && `${m[1]}.${m[2]}.${m[3]}` === date && BigInt(m[4]) > n) n = BigInt(m[4]);
  }
  return `${date}.${n + 1n}`;
}

/** Whether a publish gets a release: when a version moves among the changes
 * given. Which inputs count is the caller's (candidate.ts KINDS `releases`:
 * app releases, not the nixpkgs moves or the catch-up); a verified same-tag
 * re-pin or a marker moves no version. */
export const needsRelease = (changes: { repo: string; from: string | null; to: string }[]) =>
  changes.some((c) => c.from !== c.to);

/** Commits on the first-parent history of `ref` (newest first) with their
 * trailers. */
export interface Commit {
  sha: string;
  trailer: string | null;
}
export function firstParent(ref = "HEAD", dir = "."): Commit[] {
  const r = tryRun("git", ["-C", dir, "log", "--first-parent", "--format=%H%x00%B%x01", ref]);
  if (r.status !== 0) throw new Error(`git log: ${r.stderr}`);
  return r.stdout.split("\x01").map((s) => s.replace(/^\n/, "")).filter(Boolean).map((s) => {
    const [sha, body] = s.split("\x00");
    return { sha: sha.trim(), trailer: trailerOf(body ?? "") };
  });
}

/** The pins at a commit, by repository. */
export function pinsAt(sha: string, dir = "."): Map<string, Pin> {
  const out = new Map<string, Pin>();
  for (const s of SOURCES) {
    const r = tryRun("git", ["-C", dir, "show", `${sha}:versions/${s.repo}.json`]);
    if (r.status === 0) {
      try { out.set(s.repo, JSON.parse(r.stdout)); } catch { /* not a pin */ }
    }
  }
  return out;
}

export interface VersionChange {
  repo: string;
  from: string | null;
  to: string;
  tag: string;
}
/** Every version change between two commits, walking the first-parent
 * commits from `from` (exclusive; null: the start) to `to`, so hand
 * re-pins and changes undone in between are all listed. */
export function changesBetween(commits: Commit[], fromSha: string | null, toSha: string, pins = (sha: string) => pinsAt(sha)): VersionChange[] {
  // `commits` is newest first.
  const end = commits.findIndex((c) => c.sha === toSha);
  const start = fromSha ? commits.findIndex((c) => c.sha === fromSha) : commits.length;
  if (end < 0 || start < 0 || start < end) return [];
  const span = commits.slice(end, start).reverse();
  const out: VersionChange[] = [];
  let before = fromSha ? pins(fromSha) : new Map<string, Pin>();
  for (const c of span) {
    const now = pins(c.sha);
    for (const s of SOURCES) {
      const a = before.get(s.repo), b = now.get(s.repo);
      if (b && a?.version !== b.version) out.push({ repo: s.repo, from: a?.version ?? null, to: b.version, tag: b.tag });
    }
    before = now;
  }
  return out;
}

/** A release's body: every package at the commit and how to pin it, and
 * every version change since the previous release-trailer commit, linked to
 * upstream's release notes. The first release lists the initial pins. */
export function releaseBody(name: string, sha: string, pins: Map<string, Pin>, changes: VersionChange[], first: boolean, repo = "boltflake/artcraft-nix"): string {
  const lines: string[] = [];
  lines.push(first ? "The first release: every package's initial pin." : "Changes since the previous release:", "");
  if (!first) {
    if (!changes.length) lines.push("- (none)");
    for (const c of changes) {
      const dir = c.from && compareVersions(c.to, c.from) < 0 ? " (back to an earlier release: the newer one was pulled)" : "";
      lines.push(`- ${c.repo} ${c.from ?? "(new)"} → [${c.to}](${releasePage(c.repo, c.tag)})${dir}`);
    }
    lines.push("");
  }
  lines.push("## Packages", "", "| Package | Version |", "| --- | --- |");
  for (const s of SOURCES) {
    const p = pins.get(s.repo);
    if (!p) continue;
    for (const pkg of Object.keys(p.packages)) {
      const gone = p.unavailable?.packages.includes(pkg) ? " (unavailable)" : "";
      lines.push(`| ${pkg} | [${p.version}](${releasePage(s.repo, p.tag)})${gone} |`);
    }
  }
  lines.push("", "## Pin this release", "", "```nix",
    `inputs.artcraft-nix.url = "github:${repo}/${name}";`, "```", "",
    `Without flakes: \`https://github.com/${repo}/archive/${name}.tar.gz\`. Commit ${sha}.`,
    "", `Upstream: [${OWNER}](https://github.com/${OWNER}).`);
  return lines.join("\n");
}
