// Where every package's releases come from, shared by the watcher (a
// Cloudflare Worker) and the updater, so both select the same release. Pure
// data and functions: no Node or Worker APIs, so either can bundle it.

export const OWNER = "storytold";
export const SYSTEMS = ["x86_64-linux", "aarch64-linux"] as const;
export type System = (typeof SYSTEMS)[number];
/** The architecture in upstream's asset names. */
export const ARCH: Record<System, string> = { "x86_64-linux": "x86_64", "aarch64-linux": "aarch64" };

/** The signed checksum manifest and its detached signature, by fixed name. */
export const MANIFEST = "SHA256SUMS.txt";
export const SIGNATURE = "SHA256SUMS.txt.asc";

export interface Source {
  /** The repository under OWNER. */
  repo: string;
  /** Tags that count: published releases only, plain X.Y.Z. */
  tags: RegExp;
  /** What comes before the version in a tag. */
  prefix: string;
  /** Each package this release provides, and its asset name; `{version}` and
   * `{arch}` are filled in. */
  packages: Record<string, string>;
  /** Repository files pinned as licence notices, from the tag's commit (Studio
   * ships none in its archive). */
  licenses?: string[];
}

const app = (repo: string, extra: Record<string, string> = {}): Source => ({
  repo,
  tags: /^v(\d+)\.(\d+)\.(\d+)$/,
  prefix: "v",
  packages: { [repo]: `${repo}-{version}-linux-{arch}.tar.gz`, ...extra },
});

/** Every repository, in the order the README and the status page list them. */
export const SOURCES: Source[] = [
  app("photocraft"),
  app("vectorcraft"),
  app("filmcraft"),
  app("lightcraft"),
  app("pdfcraft", { "pdfcraft-cli": "pdfcraft-cli-{version}-linux-{arch}.tar.gz" }),
  app("effectcraft"),
  app("anicraft"),
  app("designcraft"),
  app("figcraft", { "figcraft-server": "figcraft-server-{version}-linux-{arch}.tar.gz" }),
  app("texturecraft"),
  app("materialcraft"),
  app("soundcraft"),
  app("wordcraft"),
  app("deckcraft"),
  app("cadcraft"),
  app("gridcraft"),
  app("craft-anything"),
  {
    repo: "artcraft",
    tags: /^artcraft-v(\d+)\.(\d+)\.(\d+)$/,
    prefix: "artcraft-v",
    packages: { "artcraft-studio": "artcraft-{version}-linux-{arch}.tar.gz" },
    licenses: ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"],
  },
];

export const sourceOf = (repo: string): Source => {
  const s = SOURCES.find((x) => x.repo === repo);
  if (!s) throw new Error(`unknown repository ${JSON.stringify(repo)}`);
  return s;
};

/** The repository a package comes from. */
export const repoOfPackage = (pkg: string): string | null =>
  SOURCES.find((s) => Object.hasOwn(s.packages, pkg))?.repo ?? null;

/** How many of a repository's newest releases are read (paginated). */
export const RECENT = 30;
/** How many pages of RECENT releases a reader follows at most. */
export const RELEASE_PAGES = 3;
/** How long a higher matching release may stay ineligible before an
 * `incomplete-release` issue opens. */
export const INCOMPLETE_AFTER_MS = 60 * 60 * 1000;

/** A release as both readers see it (REST and GraphQL are normalised to
 * this). An asset's `digest` is GitHub's "sha256:<hex>" or null. */
export interface Release {
  id: number | string;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  assets: ReleaseAsset[];
  /** False when the asset list wasn't read in full. */
  assetsComplete: boolean;
}
export interface ReleaseAsset {
  name: string;
  id: number | string;
  digest: string | null;
  /** "uploaded" once GitHub has the whole file. */
  state: string;
  size: number;
}

/** The version in a tag, as its decimal strings exactly as tagged (asset
 * names repeat them; numbers would round past 2^53), or null for a tag that
 * doesn't count. */
export function versionParts(source: Source, tag: string): string[] | null {
  const m = source.tags.exec(tag);
  return m ? m.slice(1, 4) : null;
}
export const versionOf = (source: Source, tag: string): string | null => versionParts(source, tag)?.join(".") ?? null;

/** Semver order of X.Y.Z (no prereleases: they never match), exact at any
 * size. */
export function compareVersions(a: string, b: string): number {
  // Anything that isn't X.Y.Z (a hand-edited issue, say) compares as before,
  // by Number, and never throws.
  const exact = /^\d+\.\d+\.\d+$/;
  const parts = (v: string): (bigint | number)[] => (exact.test(a) && exact.test(b) ? v.split(".").map((x) => BigInt(x)) : v.split(".").map(Number));
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The asset name each package needs on each system. */
export function requiredAssets(source: Source, version: string): { pkg: string; system: System; name: string }[] {
  const out: { pkg: string; system: System; name: string }[] = [];
  for (const [pkg, template] of Object.entries(source.packages)) {
    for (const system of SYSTEMS) {
      out.push({ pkg, system, name: template.replaceAll("{version}", version).replaceAll("{arch}", ARCH[system]) });
    }
  }
  return out;
}
/** Every asset a release must have to count: the tarballs, the manifest and
 * its signature. */
export const requiredNames = (source: Source, version: string): string[] => [
  ...requiredAssets(source, version).map((a) => a.name),
  MANIFEST,
  SIGNATURE,
];

const goodDigest = (d: unknown): d is string => typeof d === "string" && /^sha256:[0-9a-f]{64}$/.test(d);

/** Why a release doesn't count yet, or null when it is eligible. A tag that
 * doesn't match at all isn't asked about (it's ignored silently). */
export function ineligible(source: Source, r: Release): string | null {
  const version = versionOf(source, r.tag);
  if (!version) return "tag doesn't match";
  if (r.draft) return "a draft";
  if (r.prerelease) return "a prerelease";
  const byName = new Map(r.assets.map((a) => [a.name, a]));
  const missing: string[] = [];
  for (const name of requiredNames(source, version)) {
    const a = byName.get(name);
    if (!a || a.state !== "uploaded" || !goodDigest(a.digest)) missing.push(name);
  }
  if (missing.length && !r.assetsComplete) return "its asset list wasn't read in full";
  return missing.length ? `missing or not uploaded: ${missing.join(", ")}` : null;
}

/** What the readers decide from a repository's recent releases. */
export interface Selection {
  /** The highest eligible release by semver, or null. */
  candidate: Release | null;
  /** Releases with a matching tag above the candidate that aren't eligible
   * (published ones only: drafts are upstream's work in progress). */
  waiting: { release: Release; reason: string }[];
}

export function select(source: Source, releases: Release[]): Selection {
  const matching = releases.filter((r) => versionOf(source, r.tag) !== null);
  const byVersion = (a: Release, b: Release) => compareVersions(versionOf(source, b.tag)!, versionOf(source, a.tag)!);
  const sorted = [...matching].sort(byVersion);
  const candidate = sorted.find((r) => ineligible(source, r) === null) ?? null;
  const above = candidate ? sorted.filter((r) => byVersion(r, candidate) < 0) : sorted;
  const waiting = above
    .filter((r) => !r.draft && !r.prerelease)
    .map((release) => ({ release, reason: ineligible(source, release)! }));
  return { candidate, waiting };
}

/** What identifies a release's files: every required asset's ID and digest,
 * by name. A same-tag re-upload, a repaired signature or an asset-ID-only
 * change all give a new fingerprint. Holds are keyed by it. */
export function fingerprint(source: Source, r: Release): string {
  const version = versionOf(source, r.tag);
  if (!version) throw new Error(`${source.repo}: ${r.tag} doesn't match`);
  const byName = new Map(r.assets.map((a) => [a.name, a]));
  return requiredNames(source, version)
    .sort()
    .map((n) => {
      const a = byName.get(n);
      return `${n}=${a ? `${a.id}:${a.digest ?? "-"}` : "-"}`;
    })
    .join(",");
}

/** A REST release (`GET /repos/{owner}/{repo}/releases`) as a Release. */
export function fromRest(r: any): Release {
  return {
    id: r?.id,
    tag: String(r?.tag_name ?? ""),
    draft: Boolean(r?.draft),
    prerelease: Boolean(r?.prerelease),
    publishedAt: typeof r?.published_at === "string" ? r.published_at : null,
    assets: (Array.isArray(r?.assets) ? r.assets : []).map((a: any) => ({
      name: String(a?.name ?? ""),
      id: a?.id,
      digest: typeof a?.digest === "string" ? a.digest : null,
      state: String(a?.state ?? ""),
      size: Number(a?.size ?? 0),
    })),
    // REST lists every asset of a release in one response.
    assetsComplete: Array.isArray(r?.assets),
  };
}

/** The tag's release page, for the status page and release notes. */
export const releasePage = (repo: string, tag: string) =>
  `https://github.com/${OWNER}/${repo}/releases/tag/${encodeURIComponent(tag)}`;
export const downloadUrl = (repo: string, tag: string, name: string) =>
  `https://github.com/${OWNER}/${repo}/releases/download/${tag}/${name}`;

// GraphQL, for the watcher: one query for every repository.
/** Required assets of these releases are asked for by exact name. */
export const ASSET_PAGE = 100;
export const releaseFields = `databaseId tagName isDraft isPrerelease publishedAt`;
export function repoQuery(alias: string, repo: string, after: string | null): string {
  return `${alias}: repository(owner: ${JSON.stringify(OWNER)}, name: ${JSON.stringify(repo)}) {
    releases(first: ${RECENT}${after ? `, after: ${JSON.stringify(after)}` : ""}, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor } nodes { ${releaseFields} } } }`;
}
/** One release's assets by exact name (at most ASSET_PAGE names), with its
 * draft and prerelease flags (a pin past the listing is judged by them). */
export function assetsQuery(alias: string, repo: string, tag: string, names: string[]): string {
  const fields = names
    .map((n, i) => `a${i}: releaseAssets(first: 1, name: ${JSON.stringify(n)}) { nodes { name id digest size } }`)
    .join(" ");
  return `${alias}: repository(owner: ${JSON.stringify(OWNER)}, name: ${JSON.stringify(repo)}) { release(tagName: ${JSON.stringify(tag)}) { isDraft isPrerelease ${fields} } }`;
}
/** GraphQL's asset data for one release (from assetsQuery) as assets. GraphQL
 * lists only uploaded assets, so they count as uploaded. Its asset IDs are
 * node IDs, not REST's numbers: the watcher compares them only with its own
 * earlier state. */
export function assetsFromGraphql(node: any): ReleaseAsset[] | null {
  if (!node || typeof node !== "object") return null;
  const out: ReleaseAsset[] = [];
  for (const v of Object.values(node)) {
    const a = (v as any)?.nodes?.[0];
    if (a && typeof a.name === "string") {
      out.push({ name: a.name, id: a.id, digest: typeof a.digest === "string" ? a.digest : null, state: "uploaded", size: Number(a.size ?? 0) });
    }
  }
  return out;
}

/** Whether a repository's releases, read newest first (by creation), go back
 * far enough that older ones can't change the selection. With no pin, one
 * page is enough; with the pin published and not a prerelease, the list
 * must reach it. Once the pin is pulled (listed as a draft or prerelease)
 * or out by tag (`pinGone`: 404, or read by tag as a draft or prerelease
 * when the window doesn't list it), main follows back to the
 * highest eligible release below it, which can be anywhere in the list
 * (a backport created since the pin, or the release main was on before
 * it): the whole window is read, to the list's end or RELEASE_PAGES pages
 * (`atEnd`), and then any eligible release in it will do (one above the
 * pin as well as below); the highest of the window is selected. Out of pages with none: truncated,
 * unknown, and the previous state stands (a reader whose list ended knows
 * none remains, and needs no answer from here). (A release created before
 * the window, or before the pin with a higher version, is not looked for.) */
export function farEnough(source: Source, releases: Release[], pinTag: string | null, assetsKnown = true, pinGone = false, atEnd = false): boolean {
  const pin = pinTag ? versionOf(source, pinTag) : null;
  if (!pin) return true;
  // Every release created after the pin is listed before it: the list must
  // reach the pin (a lower release seen first, a backport say, proves
  // nothing about what's between).
  const at = releases.findIndex((r) => r.tag === pinTag);
  if (at >= 0 && !releases[at].draft && !releases[at].prerelease) return true;
  if (at < 0 && !pinGone) return false;
  if (!atEnd) return false;
  // Any eligible release in the window settles it: the selection takes
  // the highest eligible version among the releases in the window.
  return releases.some((r) => {
    if (r.tag === pinTag || versionOf(source, r.tag) === null) return false;
    // A reader that lists releases without their assets (the watcher, whose
    // follow-ups read them after) takes a published release.
    return assetsKnown ? ineligible(source, r) === null : !r.draft && !r.prerelease;
  });
}
