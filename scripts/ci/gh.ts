// The one place the update workflow talks to GitHub. Two implementations
// (and tests/fake-gh.ts) share one interface:
//   GitHub  the real REST API, with fetch and the workflow's GH_TOKEN
//   DryRun  reads through a real client, records every write instead of doing
//           it (the workflow's dry_run input); nothing on GitHub changes
//
// Refs are always full names ("refs/heads/...", "refs/tags/...").
import { Failed, UA } from "../lib/util.ts";

export const REPO = process.env.GITHUB_REPOSITORY ?? "boltflake/artcraft-nix";
export const LABEL = "artcraft-nix";

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  comments?: string[];
}

export interface Client {
  issues(): Promise<Issue[]>;
  createIssue(title: string, body: string): Promise<Issue>;
  comment(number: number, body: string): Promise<void>;
  editIssue(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void>;
  createStatus(sha: string, state: string, description: string, url: string, context?: string): Promise<void>;
  dispatch(workflow: string, ref: string, inputs: Record<string, string>): Promise<void>;
  workflowState(workflow: string): Promise<string>;
  /** Whether the workflow run with this ID has finished. */
  runCompleted(id: string): Promise<boolean>;
  enableWorkflow(workflow: string): Promise<void>;
  /** {full ref: sha} for refs under a short prefix ("tags/20"). */
  refs(prefix: string): Promise<Record<string, string>>;
  createRef(ref: string, sha: string): Promise<void>;
  deleteRef(ref: string): Promise<void>;
  /** Every published GitHub release (all pages, drafts left out): tag, id,
   * and whether it's a prerelease (which GitHub won't mark latest). */
  releases(): Promise<Release[]>;
  /** GitHub's latest release: the one marked latest, else the newest
   * published one; null when there's none (a 404). Making a release with
   * make_latest "false" leaves it; "false" on the latest doesn't clear it. */
  latestRelease(): Promise<Release | null>;
  /** The release for this tag, or null. */
  releaseByTag(tag: string): Promise<Release | null>;
  /** Create a release for an existing tag at `target`, never marked latest.
   * Raises GitHub's error as it is (a 422 when one exists already). */
  createRelease(r: { tag: string; target: string; name: string; body: string }): Promise<Release>;
  /** Mark this release latest, changing nothing else about it. */
  markLatest(r: Release): Promise<void>;
  /** Writes recorded by a dry run, or null. */
  actions?: Record<string, unknown>[] | null;
}

export interface Release {
  id: number;
  tag: string;
  /** GitHub can't mark a prerelease latest. */
  prerelease: boolean;
}

/** A release as the API returns it, as Client's methods give it. */
const release = (r: any): Release => ({ id: r.id, tag: r.tag_name, prerelease: r.prerelease === true });

export class GitHub implements Client {
  readonly repo: string;
  readonly token: string;

  constructor(repo = REPO, token = process.env.GH_TOKEN ?? "") {
    this.repo = repo;
    this.token = token;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${this.repo}/${path}`, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Failed(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  /** Every page of a list endpoint. */
  private async all(path: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.api("GET", `${path}${sep}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  /** Open issues only (the status page). */
  async openIssues(): Promise<Issue[]> {
    const items = await this.all(`issues?labels=${LABEL}&state=open`);
    return items.filter((i) => !i.pull_request && i.state === "open")
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", state: "open" as const }));
  }
  async issues() {
    const items = await this.all(`issues?labels=${LABEL}&state=all`);
    return items.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", state: i.state }));
  }
  async createIssue(title: string, body: string) {
    const i = await this.api("POST", "issues", { title, body, labels: [LABEL] });
    return { number: i.number, title, body, state: "open" as const };
  }
  async comment(number: number, body: string) {
    await this.api("POST", `issues/${number}/comments`, { body });
  }
  async editIssue(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }) {
    await this.api("PATCH", `issues/${number}`, change);
  }
  async createStatus(sha: string, state: string, description: string, url: string, context = "tested") {
    await this.api("POST", `statuses/${sha}`, { state, description: description.slice(0, 140), target_url: url, context });
  }
  async dispatch(workflow: string, ref: string, inputs: Record<string, string>) {
    await this.api("POST", `actions/workflows/${workflow}/dispatches`, { ref, inputs });
  }
  async workflowState(workflow: string) {
    return (await this.api("GET", `actions/workflows/${workflow}`)).state;
  }
  async runCompleted(id: string) {
    // A run that no longer exists (deleted, or a hand-pushed ref) has finished.
    const run = await this.maybe(`actions/runs/${encodeURIComponent(id)}`);
    return run === null || run.status === "completed";
  }
  async enableWorkflow(workflow: string) {
    await this.api("PUT", `actions/workflows/${workflow}/enable`);
  }
  // matching-refs answers [] when nothing matches; any error (auth, rate
  // limit, outage) is raised, never mistaken for "no refs". It isn't
  // paginated: one request returns every match (paging it would repeat the
  // whole list forever once there are 100 tags).
  // An annotated tag's ref names the tag object: it's peeled to the commit
  // it points at, which is what reconcile compares with a trailer commit.
  async refs(prefix: string) {
    const items: any[] = (await this.api("GET", `git/matching-refs/${prefix}`)) ?? [];
    const out: Record<string, string> = {};
    for (const r of items) {
      let { sha, type } = r.object;
      for (let k = 0; type === "tag" && k < 5; k++) ({ sha, type } = (await this.api("GET", `git/tags/${sha}`)).object);
      if (type === "tag") throw new Failed(`${r.ref}: a tag of tags too deep to peel`);
      out[r.ref] = sha;
    }
    return out;
  }
  async createRef(ref: string, sha: string) {
    await this.api("POST", "git/refs", { ref, sha });
  }
  async deleteRef(ref: string) {
    await this.api("DELETE", `git/${ref}`);
  }
  async releases() {
    // Drafts aren't releases yet: releases/tags/<tag> doesn't find them, and
    // one can't be marked latest. A hand-made draft doesn't block the real one.
    return (await this.all("releases")).filter((r) => !r.draft).map(release);
  }
  /** GET, or null on a 404. */
  private async maybe(path: string): Promise<any | null> {
    try {
      return await this.api("GET", path);
    } catch (e: any) {
      if (/: HTTP 404 /.test(String(e?.message))) return null;
      throw e;
    }
  }
  async latestRelease() {
    const r = await this.maybe("releases/latest");
    return r ? release(r) : null;
  }
  async releaseByTag(tag: string) {
    const r = await this.maybe(`releases/tags/${encodeURIComponent(tag)}`);
    return r ? release(r) : null;
  }
  async createRelease(r: { tag: string; target: string; name: string; body: string }) {
    const made = await this.api("POST", "releases", {
      tag_name: r.tag, target_commitish: r.target, name: r.name, body: r.body, make_latest: "false",
    });
    return release(made);
  }
  async markLatest(r: Release) {
    await this.api("PATCH", `releases/${r.id}`, { make_latest: "true" });
  }
}

export class DryRun implements Client {
  readonly reader: Client | null;
  actions: Record<string, unknown>[] = [];

  constructor(reader: Client | null = null) {
    this.reader = reader;
  }
  private record(action: string, args: Record<string, unknown>) {
    this.actions.push({ action, ...args });
  }
  async issues() { return this.reader ? this.reader.issues() : []; }
  async workflowState(workflow: string) { return this.reader ? this.reader.workflowState(workflow) : "active"; }
  async runCompleted(id: string) { return this.reader ? this.reader.runCompleted(id) : false; }
  async refs(prefix: string) { return this.reader ? this.reader.refs(prefix) : {}; }
  async releases() { return this.reader ? this.reader.releases() : []; }
  // A Latest this dry run marked is what later reads see (as a real run's
  // would), so a rehearsed repair reports as made.
  private latest: Release | null = null;
  async latestRelease() { return this.latest ?? (this.reader ? this.reader.latestRelease() : null); }
  async releaseByTag(tag: string) { return this.reader ? this.reader.releaseByTag(tag) : null; }
  async createRelease(r: { tag: string; target: string; name: string; body: string }) {
    this.record("create_release", { tag: r.tag, target: r.target, name: r.name, make_latest: "false", body: r.body });
    return { id: -this.actions.length, tag: r.tag, prerelease: false };
  }
  async markLatest(r: Release) { this.record("mark_latest", { tag: r.tag }); this.latest = r; }
  async createIssue(title: string, body: string) {
    this.record("create_issue", { title, body });
    return { number: -this.actions.length, title, body, state: "open" as const };
  }
  async comment(number: number, body: string) { this.record("comment", { number, body }); }
  async editIssue(number: number, change: { title?: string; body?: string; state?: string }) { this.record("edit_issue", { number, ...change }); }
  async createStatus(sha: string, state: string, description: string, url: string, context = "tested") {
    this.record("create_status", { sha, state, description, target_url: url, context });
  }
  async dispatch(workflow: string, ref: string, inputs: Record<string, string>) { this.record("dispatch", { workflow, ref, inputs }); }
  async enableWorkflow(workflow: string) { this.record("enable_workflow", { workflow }); }
  async createRef(ref: string, sha: string) { this.record("create_ref", { ref, sha }); }
  async deleteRef(ref: string) { this.record("delete_ref", { ref }); }
}

/** The client for this run: DryRun when DRY_RUN=true, else the real API. */
export function client(): Client {
  const real = new GitHub();
  return process.env.DRY_RUN === "true" ? new DryRun(real) : real;
}
