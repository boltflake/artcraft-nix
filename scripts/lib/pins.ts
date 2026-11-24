// Building a pin from a verified release: shared by pin.ts and the updater.
import { OWNER, versionOf, type Release, type Source } from "../../shared/sources.ts";
import { verifyRelease, type VerifyDeps } from "./verify.ts";
import { fail, get, getJson, sha256Hex, sri, Transient, type Pin } from "./util.ts";

const SAFE = /^[A-Za-z0-9._+-]+$/;

/** The commit a tag points at (a tag can move; a commit can't). */
export async function tagCommit(repo: string, tag: string, fetchJson = getJson): Promise<string> {
  const ref = await fetchJson(`https://api.github.com/repos/${OWNER}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref?.object ?? fail(`${repo}: no tag ${tag}`);
  for (let depth = 0; object?.type === "tag"; depth++) {
    if (depth >= 5) fail(`${repo} ${tag}: tag nested too deeply`);
    object = (await fetchJson(`https://api.github.com/repos/${OWNER}/${repo}/git/tags/${object.sha}`))?.object;
  }
  const commit: string = object?.type === "commit" ? object.sha : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`${repo} ${tag}: can't resolve the tag's commit`);
  return commit;
}

export interface PinDeps extends VerifyDeps {
  fetchJson?: (url: string) => Promise<any>;
  now?: Date;
}

/** A verified release as its pin. `previous`: the current pin, whose licence
 * hashes are reused while the tag's commit is unchanged, and whose
 * `released` is kept at the same version. */
export async function buildPin(source: Source, release: Release, previous: Pin | null, deps: PinDeps = {}): Promise<Pin> {
  const version = versionOf(source, release.tag) ?? fail(`${release.tag} doesn't match`);
  if (!SAFE.test(release.tag)) fail(`bad tag ${JSON.stringify(release.tag)}`);
  const verified = await verifyRelease(source, release, deps);
  let licenses: Pin["licenses"];
  if (source.licenses?.length) {
    const commit = await tagCommit(source.repo, release.tag, deps.fetchJson);
    licenses = {};
    for (const path of source.licenses) {
      const url = `https://raw.githubusercontent.com/${OWNER}/${source.repo}/${commit}/${path}`;
      const reuse = previous?.licenses?.[path];
      if (reuse?.url === url) {
        licenses[path] = reuse;
        continue;
      }
      const bytes = await (deps.fetchBytes ?? ((u: string) => get(u)))(url);
      if (!bytes) throw new Transient(`${url} didn't download`);
      licenses[path] = { url, hash: sri(sha256Hex(bytes)) };
    }
  }
  const now = deps.now ?? new Date();
  const sameVersion = previous?.version === version;
  const released: Pin["released"] = sameVersion && previous?.released
    ? previous.released
    : release.publishedAt && Date.parse(release.publishedAt) <= now.getTime()
      ? { at: new Date(release.publishedAt).toISOString(), kind: "published" }
      : { at: now.toISOString(), kind: "seen" };
  return {
    repo: source.repo,
    version,
    tag: release.tag,
    releaseId: Number(release.id),
    manifest: verified.manifest,
    signature: verified.signature,
    packages: verified.packages,
    ...(licenses ? { licenses } : {}),
    released,
  };
}
