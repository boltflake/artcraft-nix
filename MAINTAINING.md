# Maintaining artcraft-nix

Notes for whoever runs this flake: setting it up, the issues it opens, and the
rules for changing it. For using it, see the [README](README.md). The design
follows [t3code-nix](https://github.com/boltflake/t3code-nix) wherever the two
problems are the same.

## Setting up, once

**The repository and its first commit.** The first commit is pushed to
`main` by hand, to start the history. Then set up two rulesets, neither with
bypass actors (the update bot has none either):

- on `main`: no deletion, fast-forwards only, and the `tested` status
  required;
- on `refs/tags/20*`: no deletion and no update (release names are
  `YYYY.MM.DD.N`).

Publish posts `tested` on the candidate commit and pushes it, as t3code-nix
does; every other change goes through branch CI (`ci.yml`): one commit on
top of `main`, the full suite on both systems, then fast-forward `main`.

**The release watcher.** It runs on Cloudflare (`watcher/`), in the same
account as t3code-nix's, as its own Worker (`artcraft-nix-watcher`) with its
own KV namespace. `deploy-watcher.yml` deploys it on every change to
`watcher/` or `shared/` on `main`, and rolls back when a deploy never
reports healthy (only if the live version is still the one it deployed). The
first deploy is by hand, from a checkout of `main`, signed in with `wrangler
login`, since the workflow's token can't create the Worker:

```sh
cd watcher
sed -i "s/KV_NAMESPACE_ID/your-kv-namespace-id/" wrangler.jsonc  # don't commit this
export CLOUDFLARE_ACCOUNT_ID=your-account-id
nix shell --inputs-from .. nixpkgs#wrangler -c sh -c '
  wrangler login
  wrangler deploy
  wrangler secret put GITHUB_TOKEN
  wrangler secret put HEALTH_TOKEN'
git checkout wrangler.jsonc
```

`GITHUB_TOKEN` is a fine-grained token for this repository only, with
Actions read and write (for `workflow_dispatch`: the update run on each
change, and `pages.yml` and `health.yml` about hourly, since GitHub's own
schedule drops runs; those ride on the watcher's existing KV writes and add
none) and Contents read (the watcher reads the pins on `main`), with a
one-year expiry. `HEALTH_TOKEN` is any long random string. Then set, in
the repository:

- the secret `WATCHER_HEALTH_TOKEN` to the same `HEALTH_TOKEN`;
- the variable `WATCHER_URL` to the `workers.dev` address `wrangler deploy`
  printed;
- the variables `CLOUDFLARE_ACCOUNT_ID` and `WATCHER_KV_ID`, and the secret
  `CLOUDFLARE_API_TOKEN`.

`CLOUDFLARE_API_TOKEN` is a user token with only "Workers Scripts: Edit".
The user token editor grants that for the whole account, not one Worker
(checked 2026-11-24), so this token can also edit t3code-nix's Worker.
Cloudflare documents a per-Worker role for account-owned API tokens, which
would limit it to this Worker; an account of its own would too. GitHub's
5,000 GraphQL points an hour are per user, shared with t3code-nix's watcher
when both tokens belong to the same user. A query covering all 18
repositories and their pins cost 1 point (measured 2026-11-24); a sweep
makes one such request a minute, plus follow-ups when releases or pins
change, so about 60 points an hour when quiet.

Check it with
`curl -H "Authorization: Bearer <HEALTH_TOKEN>" <WATCHER_URL>/health`.

**Turning updates on.** Update runs are real only once the repository
variable `UPDATES` is `true`; until then the hourly backstop dispatches
nothing and opens no issues, and a dispatched run stops before reading
upstream. A dry run (`dry_run`) works either way. Before turning it on,
re-pin every repository through branch CI (`node scripts/pin.ts --all`, one
commit), so the first real run has almost nothing to catch up on. The status
page deploys only once `PAGES` is `true`, with the Pages source set to
"GitHub Actions".

**Security settings.** Turn on, in the repository's Settings under "Advanced
Security": secret scanning with push protection, private vulnerability
reporting (SECURITY.md's link), and CodeQL's default setup for
JavaScript/TypeScript and Python only. Its Actions language is left off:
zizmor, in the unit check, already lints the workflows and fails the change.

## The trusted signing key

`keys/release-signing-key.asc` and `keys/trusted.json` hold upstream's
release key: primary `2B76741B414AAD6CD33E631213A005C0B9D7C3ED` (certify
only), signing subkey `568DC1F68F8FAECC797F3C7B006DAF6BB0EF334E`, uid
"ArtCraft Linux Release Signing Key", created 2026-11-03.

It was **trusted on first use** on 2026-11-22: the same
`release-signing-key.asc` (sha256 `8e6925a1…`) is attached to the latest
release of all 18 repositories, and it was seen on photocraft, anicraft,
craft-launcher, artcraft and figcraft. getartcraft.com publishes no key or
fingerprint, and the fingerprint hasn't been confirmed with upstream.

The verifier (`scripts/lib/verify.ts`) checks `SHA256SUMS.txt.asc` over the
exact bytes of `SHA256SUMS.txt` in a fresh keyring holding only this key,
reads the signer from GnuPG's status output, and never fetches keys. A key
attached to a release is never trusted for being there. A release signed by
any other key or subkey is held with an `integrity` issue.

**A key change** is a reviewed hand commit to `keys/`, through branch CI,
after checking with upstream. On the next run, releases held for an unknown
key are verified afresh; stable pins keep their verified hashes.

## When an issue opens

The update runs, the hourly health check and the weekly tooling check open
issues and close them by themselves (`PROBLEMS` in `scripts/ci/issues.ts`).
Each issue is keyed by kind, repository and scope, hidden in its body. Holds
are per repository release, keyed by the release's fingerprint (every
required asset's ID and digest): a repaired upload is a new input.

| Issue | What it means | What to do | It closes when |
| --- | --- | --- | --- |
| `test-failed` | A release failed the tests (alone, in narrowing) | Read the failing checks; the smoke's log and screenshot are in the run's artifacts. Fix the packaging (a new `dlopen` library, a changed layout) through branch CI | The release passes, or a newer one supersedes it |
| `combination-failed` | A release passed alone but failed with the others | Usually a shared-path collision (`aggregate`) | As above |
| `integrity` | A release didn't verify (signature, signer, manifest entry, digest); or a same-version asset change that did verify was re-pinned (for the record) | For a hold: look at the release; a key change is a hand change. For the record: nothing | The release verifies, or a verified newer one is pinned |
| `incomplete-release` | A higher release is still missing files an hour after publishing | Usually nothing: upstream finishes uploading | It becomes eligible, a higher one is pinned, or it's withdrawn (the closing says which) |
| `unavailable` | A pinned asset is confirmed gone (404 from the API and the download host) | Nothing; the other packages carry on | A change that ends it lands on `main` (a new release, the assets back, or a verified re-upload) |
| `downgrade` | Upstream pulled the pinned release; `main` followed back | Nothing; if no eligible release remains, the pin stays | The pin is back at or above the pulled version |
| `env-broken` | `main` fails on its own, and every input does too | Fix `main` (nixpkgs, a runner change) | `main` passes |
| `update-failed` | A job failed or was cancelled (infrastructure, not a release) | Look at the run | A run completes cleanly |
| `resolve-failed` | A repository couldn't be read | Usually GitHub; it retries | The repository reads again |
| `bump-waiting` | nixpkgs hasn't moved on `main` for 14 days | Read what it names (builds missing from cache.nixos.org) | flake.lock moves on `main` |
| `stable-broken` / `stable-behind` | NixOS stable fails, or its snapshot lags `main` | Look at the stable legs' results | The snapshot catches up |
| `stable-unfetchable` | A download the stable snapshot pins is gone | As `unavailable` | Every snapshot download answers |
| `studio-hosts` | Studio's page names a host the committed list doesn't, or extraction failed | Review the host; add it to `shared/studio-hosts.json` as `disclosed` through branch CI. Marking one `blocked` changes what the option blocks: a deliberate change, so update the README with it | The list records it (or extraction works again) |
| `tag-mismatch` / `latest-mismatch` | A release tag on another commit than its trailer names, a release-name tag no commit on `main` names, or the Latest marker can't be placed | Look into it by hand; a tag is never moved | Reconcile finds it right |
| `watcher-stalled` / `watcher-auth` / `update-lag` | From the hourly backstop: `watcher-stalled` when the watcher's writes or polling are stale, or something it does (a read, the update dispatch, or the hourly start of `pages.yml` or `health.yml`) has failed for over 6 hours, a disabled `pages.yml` included (a disabled `health.yml` can't report itself, and once the update run re-enables it, the next successful send can clear the error before health reads it; after a rollback to a watcher version without the hourly starts, a start error saved before it stays in `/health` until the next deploy); `watcher-auth` when its token is refused; `update-lag` when a release waits on `main` for over an hour | For `watcher-auth`, rotate the token (`wrangler secret put GITHUB_TOKEN`); otherwise look at the watcher | Three healthy checks in a row; the release lands |
| `tooling-outdated` | A newer runner image, Node LTS line, or actionlint knowing the runner labels | An ordinary change | The weekly check finds it current |

## How a run works

`update.yml`, as in t3code-nix: resolve (read upstream and `main` fresh, verify,
write pins), test the candidate on both systems in parts
(`scripts/lib/parts.ts`: three app parts by size, Studio, the flake-wide checks,
`default-build`) and NixOS stable's two groups, then narrow if it failed (`main`
alone in parts, each input alone, the final tree again), publish (fast-forward
only; when `main` moves it re-dispatches, at most 3 runs in a row), reconcile
tags and releases, and write issues. A test job fails only when it couldn't
produce a complete result; a check failing is a verdict read from its result
file. Every run tests every package. A held release is retried in a run with
nothing new; so is a NixOS-stable snapshot that lags `main`'s releases (the
input `stable-snapshot`, with no files: main's tree is tested, and the snapshot
moves, with no release name, only once stable-next passes). A catch-up that
stable-next turned down with complete results isn't retried until `main` moves
(the `stable-behind` issue records the tree).

**Releases** are named `YYYY.MM.DD.N` and allocated by publish only
(`scripts/lib/releases.ts`): the trailer `Artcraft-Release:` in the commit,
and the tag pushed with it. Hand commits never carry a trailer; their
version changes show in the next release's list. Publish also writes
`Artcraft-Queue:` (the run's elapsed time to publish, less its queue-free
critical path: each stage as long as its longest job) and `Artcraft-Waited:`
(how long it waited behind another update run, 0 when none was going), in
seconds, for the status page's speed figures.

**Speed.** The target is a median under 9 minutes from a release's
`publishedAt` to `main` moving, counting only runs with nothing ahead of
them, without runner queue time. Branch CI and update runs record a job
sampler (`scripts/ci/sample.sh`) for the timings. If the target is missed,
testing only what changed is worth revisiting.

## Making changes

### Adding a package

A new version needs no code: the updater writes the pin. A new Craft App
(a new repository under storytold) touches:

1. `shared/sources.ts` (`SOURCES`), which the watcher and the updater both
   read; then its first pin with `node scripts/pin.ts <repo>` (needs `gpg`;
   it verifies the signature like the updater).
2. `pkgs/apps.nix`: its entry (summary, files, `dlopen` beyond the common
   set, smoke WM class, data folders, files left out, fonts), filled in from
   the real archives on both systems, and `docs/acceptance-matrix.md`.
3. `scripts/lib/parts.ts` (`SIZE_MB`), `lib/overlay.nix` if nixpkgs has a
   package by that name, `scripts/lib/titles.ts` for the status page (its
   title, and the app in one of `CATEGORIES`, in alphabetical order), and
   the README's table for that category (a test holds the two to the same
   list, alphabetical).

The checks fail until the entry matches the package: `<app>-files` (exactly
the declared files), `<app>-libs` (every `dlopen` library resolves),
`as-shipped` (only the changes the builder's comment lists), and the smoke.

### Rules for packaging

- Upstream's build, as shipped. Every change for NixOS is listed in the
  package's opening comment, and `as-shipped` holds it to that list.
- Every program in `bin/` is a wrapper that unsets `APPIMAGE` and sets the
  managed-update variables (`lib/versions.nix` `wrapperArgs`); no other
  wrapper without a shown need.
- `dlopen`ed libraries go in the RPATH (`runtimeDependencies`, library
  outputs), never in a wrapper's `LD_LIBRARY_PATH`.
- No guard lists: the Craft Apps have no self-install commands.

### Inputs and evidence

A candidate's inputs have a kind (`scripts/ci/candidate.ts` `KINDS`):
a release, a marker-only change to main's own release, the nixpkgs bump,
the nixpkgs-stable pin, a stable snapshot marker, or the snapshot catch-up.
Narrowing, verdicts and publish ask that table whether an input can be
held, passes a release when it lands, gets a narrowing job of its own,
changes what NixOS stable builds, is gated on NixOS stable, or needs a
release name; a new sort of input is a new row there. These places still
go by an input's name, and a new input must be taught to each:

- `scripts/ci/candidate.ts`: `make()` (which changed file is which input)
  and `kindOf()` (an inputs.json written without kinds);
- `scripts/ci/issues.ts` `NON_PACKAGE_INPUTS`: an input that isn't a
  package. Miss it and every issue about the input closes on the next run
  as "no longer packaged";
- `scripts/update.ts`: `bumpBudget`, `retryRepos` and the held moves'
  retry tell app releases from the nixpkgs moves by name;
- `scripts/ci/test.ts` (an input alone's check scope) and `update.yml`'s
  copy of `flake.lock` for the `nixpkgs` input.

Release names follow the table alone.

Evidence about main's tree as a run found it (`stable-current`, main's
stable verdict, `env-ok`) is dropped when publish reports that main moved
under the run (`main-moved`); evidence about the snapshot as the run found
it (resolve's about its downloads, and the Studio hosts diagnostic of its
Studio) is dropped too when main moved or the landing moved the snapshot
(the next run looks at the new pins).

### The status page's fixtures and demo

`tests/fixtures/status*/` and `docs/status-demo.html` are generated from
upstream's real releases and main's pins: after a change to the status page
(`scripts/status*.ts`, `scripts/lib/titles.ts`) or the pins, run
`node tests/fixtures/status-demo/make.ts` and commit what it writes (the
`unit` check fails until they match).

### Check in operation

- An `integrity` hold on a release stays open while a later release of the
  same repository is held too (only a `pass` closes it). It holds a
  fingerprint no longer offered, so it is harmless; close it by hand if it
  lingers.
