<img src="docs/header.svg" width="100%" alt="artcraft-nix: All ArtCraft applications, packaged for Nix within minutes">

<p align="center">
  <a href="https://boltflake.github.io/artcraft-nix/"><img src="docs/live-status.svg" width="272" alt="Live: package status"></a>
</p>

This flake packages every [ArtCraft](https://getartcraft.com) app from
[storytold](https://github.com/storytold) for x86_64 and aarch64 Linux: the 17
Craft Apps, ArtCraft Studio, and two companion tools. It's a community
project, not affiliated with or endorsed by the ArtCraft team.

- **<ins>Always up to date</ins>.** A watcher checks every app's releases every minute.
  Each new release is tested and published here automatically, usually
  within minutes.
- **Tested before it's published.** Every package is built and smoke-tested
  on both systems for every update; `main` moves only if everything passes.
- **Signed releases, checked.** Each release's checksum file must carry a
  valid signature from upstream's release key, and every download must match
  it.
- **One line to install.** `programs.artcraft.enable = true;` installs every
  desktop app, Studio, and `artcraft-nix doctor`.
- **Nix stays in charge.** Built-in updaters can't replace the apps. When
  you see the update prompt and artcraft-nix has published that version, run
  `nix flake update artcraft-nix` and rebuild ([other setups](#updating)).

## Contents

- [Quick start](#quick-start)
- [Setup](#setup)
- [Packages](#packages)
- [The NixOS module](#the-nixos-module)
- [Updating](#updating)
- [What leaves your machine](#what-leaves-your-machine)
- [Studio's analytics: `hostFileBlockAnalytics`](#studios-analytics-hostfileblockanalytics)
- [NixOS stable](#nixos-stable)
- [When something isn't working: `artcraft-nix doctor`](#when-something-isnt-working-artcraft-nix-doctor)
- [Pinning and rolling back](#pinning-and-rolling-back)
- [Following new releases](#following-new-releases)
- [Details](#details)
- [Maintainer notes](#maintainer-notes)

## Quick start

Try one app without touching your configuration:

```sh
nix run github:boltflake/artcraft-nix#photocraft
nix run github:boltflake/artcraft-nix#artcraft-studio
nix run github:boltflake/artcraft-nix#pdfcraft-cli -- text some.pdf
```

Plain `nix run github:boltflake/artcraft-nix` lists the apps, since there's no
single ArtCraft program.

## Setup

<details id="with-flakes" open>
<summary><b>Flake</b></summary>
<br>

```nix
{
  inputs.artcraft-nix.url = "github:boltflake/artcraft-nix";

  outputs = { nixpkgs, artcraft-nix, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      modules = [
        ./configuration.nix                       # your existing system configuration
        artcraft-nix.nixosModules.default
        {
          programs.artcraft = {
            enable = true;                        # every desktop app, Studio, and `artcraft-nix doctor`

            # Optional: uncomment what you need
            # apps = [ "photocraft" "pdfcraft" ]; # install only these (companions too: "pdfcraft-cli", "figcraft-server")
            # excludeApps = [ "artcraft-studio" ];# or leave some out
            # nixpkgs = "stable";                 # NixOS stable's libraries (default: unstable)
            # hostFileBlockAnalytics = true;      # block Studio's analytics loaders in /etc/hosts, machine-wide (read the section first)
          };
        }
      ];
    };
  };
}
```

All options are in [The NixOS module](#the-nixos-module).

</details>

<details id="not-a-flake-yet">
<summary><b>If your system isn't a flake yet</b></summary>
<br>

1. Turn flakes on: add this line to your `configuration.nix`, then run
   `sudo nixos-rebuild switch`:

   ```nix
   nix.settings.experimental-features = [ "nix-command" "flakes" ];
   ```

2. Turn your system into a flake with the ArtCraft apps:

   ```sh
   sudo nix run github:boltflake/artcraft-nix#init
   ```

   Read what it prints before you go on: it warns about anything the flake
   would expose or couldn't see. Then:

   ```sh
   sudo nixos-rebuild switch
   ```

   This writes `/etc/nixos/flake.nix` with the apps enabled, on the same
   NixOS branch your system follows now, so it stays on its release. An
   existing `flake.nix` is never overwritten. To see the file first, add
   `-- --dry-run`. It prints the rebuild command to use.

   To go back, delete `flake.nix` (and `flake.lock`); if you've rebuilt
   with it, rebuild again or boot the previous generation.
   `nix flake init -t github:boltflake/artcraft-nix` gives you the same
   template to fill in yourself.

</details>

<details id="without-flakes">
<summary><b>Without flakes</b></summary>
<br>

Everything the flake has (the packages, the NixOS module and the overlay)
also works with `nix-env`, `nix-shell`, `nix-build` or an `import`:

```sh
# Install one app for your user (run it again to update):
nix-env -f https://github.com/boltflake/artcraft-nix/archive/main.tar.gz -iA photocraft
```

```nix
# configuration.nix
let
  artcraft-nix = import (fetchTarball "https://github.com/boltflake/artcraft-nix/archive/main.tar.gz") { };
in
{
  imports = [ artcraft-nix.nixosModules.default ];
  programs.artcraft.enable = true;
}
```

- Your machine's packages are at the top: `photocraft`, `artcraft-studio`
  and the rest; `suite` is every desktop app and Studio together. Another
  machine type's: `{ system = "aarch64-linux"; }` in the `{ }`.
- `artcraft-nix.flake` has every flake output.
- For a fixed set of versions, use a release's tarball
  (`…/archive/2026.11.22.1.tar.gz`) or a commit's.

</details>

<details id="home-manager">
<summary><b>Home Manager</b></summary>
<br>

There's no Home Manager module; the packages work in `home.packages`:

```nix
{ inputs, pkgs, ... }:
{
  home.packages = with inputs.artcraft-nix.packages.${pkgs.stdenv.hostPlatform.system}; [
    photocraft
    pdfcraft
    artcraft-studio
  ];
}
```

The apps need GL or Vulkan drivers: on NixOS set
`hardware.graphics.enable = true;` in the system configuration (the module
does it for you). On another distribution, see below.

</details>

<details id="other-distributions">
<summary><b>Nix on another distribution</b></summary>
<br>

The packages run on any x86_64 or aarch64 Linux with Nix, but Nix's apps
can't load your distribution's GL and Vulkan drivers by themselves. Run them
through [nixGL](https://github.com/nix-community/nixGL):

```sh
nix profile install github:boltflake/artcraft-nix#photocraft
nix run --impure github:nix-community/nixGL -- photocraft
```

`artcraft-nix doctor` checks for nixGL and for copies of the apps installed
by your package manager, which can shadow Nix's.

</details>

## Packages

### Photos and images

| Package | What it is |
| --- | --- |
| `lightcraft` | Organise photos and develop raw files, non-destructively |
| `photocraft` | Edit photos and layered PSD documents |

### Video, animation and sound

| Package | What it is |
| --- | --- |
| `anicraft` | Draw and animate 2D vector art on a timeline |
| `effectcraft` | Motion graphics and visual effects compositor |
| `filmcraft` | Edit video, color and sound |
| `soundcraft` | Record, edit and mix audio and MIDI |

### 3D textures and materials

| Package | What it is |
| --- | --- |
| `materialcraft` | Design procedural PBR materials with node graphs |
| `texturecraft` | Paint PBR textures directly on 3D meshes |

### Design and drawing

| Package | What it is |
| --- | --- |
| `cadcraft` | Draft, dimension and plot 2D drawings |
| `designcraft` | Lay out magazines, books and print documents |
| `figcraft` | Design and prototype user interfaces |
| `vectorcraft` | Draw and edit vector illustrations, SVG and PDF |

### Documents and office

| Package | What it is |
| --- | --- |
| `deckcraft` | Create and present slide decks |
| `gridcraft` | Calculate, analyse and chart data in workbooks |
| `pdfcraft` | Read, organize, combine, split and secure PDFs |
| `wordcraft` | Write and design documents; open and save Word files |

### AI

| Package | What it is |
| --- | --- |
| `artcraft-studio` | ArtCraft Studio: create AI images and video |
| `craft-anything` | Find out how any software works, then craft your own |

### Companion tools (headless)

| Package | What it is |
| --- | --- |
| `figcraft-server` | FigCraft's collaboration server, headless (from FigCraft's release) |
| `pdfcraft-cli` | PdfCraft's headless command-line tool (from PdfCraft's release) |

### Bundles and helpers

| Package | What it is |
| --- | --- |
| `default` | Every desktop app and Studio, in one environment (not the two companions) |
| `doctor` | `artcraft-nix doctor` ([below](#when-something-isnt-working-artcraft-nix-doctor)) |
| `init` | Makes a NixOS system that isn't a flake yet into one with the apps |

Each Craft App also installs its `-cli` (for example `photocraft-cli`).
A desktop package installs the app's binaries, desktop file, icons,
metainfo, MIME types and licences, so you get a menu entry and file
associations. The current versions are on the
[status page](https://boltflake.github.io/artcraft-nix/).

Every package is upstream's own Linux build, installed as shipped. The only
changes are the ones NixOS needs, and each package file starts with a
comment listing them: the binaries are patched to find nixpkgs' libraries,
and every program is started through a small wrapper (see
[Updating](#updating)). A check holds each package to its comment.

**`pdfcraft` and `pdfcraft-cli`** both install a `pdfcraft-cli` command; it
comes from the same release. The companion package is for the command line
without the app, and it can't do text recognition (OCR): its models come
with PdfCraft. With both installed, PdfCraft's command wins.

**`figcraft-server`** binds `127.0.0.1:47900` by default and keeps its data
in `./figcraft-data` under the directory it starts in, so give it `--data`.
There's no NixOS service for it yet.

## The NixOS module

`programs.artcraft`:

| Option | Default | What it does |
| --- | --- | --- |
| `enable` | `false` | Install every desktop app and Studio (or `apps`, less `excludeApps`), and `artcraft-nix doctor`. |
| `apps` | `null` | Install only these packages, by name: any app, `artcraft-studio`, `pdfcraft-cli`, `figcraft-server`. A name that isn't one fails evaluation. |
| `excludeApps` | `[ ]` | Leave these out. |
| `nixpkgs` | `"unstable"` | Whose libraries the apps load: `"unstable"` or `"stable"` ([NixOS stable](#nixos-stable)). |
| `hostFileBlockAnalytics` | `false` | Block Studio's analytics loaders in `/etc/hosts`, for the whole machine. Read [the section](#studios-analytics-hostfileblockanalytics) first. |

With `enable`, the module also sets `hardware.graphics.enable` (as a
default you can override) when it installs a desktop app or Studio: they
draw with GL or Vulkan. The headless companions alone don't need it.

**File dialogs** (Open, Save) use the XDG desktop portal, and fall back to
`zenity` if it's on `PATH`. Desktop environments bring their own portal; on
a bare window manager, enable one (`xdg.portal.enable = true;` with a
backend such as `xdg-desktop-portal-gtk`) or install `zenity`. The doctor
tells you if neither is there.

**A package whose files upstream deleted** stays out with a warning during
the rebuild, even if `apps` names it, and the rest install as usual (see
[Unavailable packages](#unavailable-packages)).

### Without the module

The overlay puts everything under `pkgs.artcraft-nix`, and each package at
the top level too, unless your nixpkgs has a different program by that name:

```nix
nixpkgs.overlays = [ artcraft-nix.overlays.default ];
environment.systemPackages = [ pkgs.photocraft pkgs.artcraft-nix.artcraft-studio ];
hardware.graphics.enable = true;
```

nixpkgs packages ten of the apps itself, from storytold's own repositories
(PhotoCraft, VectorCraft, FilmCraft, LightCraft, PdfCraft, SoundCraft,
WordCraft, DeckCraft, CADCraft, GridCraft). The overlay replaces those with
this flake's tested, current builds; a check makes sure that's only ever
done for the same program.

## Updating

**How an update reaches you.** Upstream publishes a release; within a minute
the watcher sees it; the update run checks its signature, builds and tests
every package on x86_64 and aarch64, and moves `main` only if everything
passes. Then it's yours once you update your Nix sources and rebuild.

**Inside the apps.** Each Craft App checks GitHub for a newer version (most
at start; AniCraft and Craft Anything when you open their update screen;
PdfCraft and PhotoCraft let you turn it off). The check is left on, as
shipped. Because the app is in the Nix store, its prompt offers only
**Download** (which opens the release page in your browser), **What's new**
and **Later**: it never installs anything. Don't download it: wait until the
[status page](https://boltflake.github.io/artcraft-nix/) shows the version,
then update as below.

Every program here is started through a wrapper that sets
`CRAFT_UPDATE_MANAGED_BY=Nix` and `CRAFT_UPDATE_MANAGED_HINT='Update your
Nix sources and rebuild to get the new version.'`, so the prompt can say
that instead. Those variables come from a proposed upstream change
([storytold/craft-libs#2975](https://github.com/storytold/craft-libs/pull/2975))
that isn't merged yet; until the apps ship it, they ignore them. The
wrapper also unsets `APPIMAGE`, which an app started from a program running
as an AppImage would otherwise inherit, and take that AppImage for its own.
Studio has no updater.

**How to update, by how you use artcraft-nix:**

<details open>
<summary><b>A flake (the module, or packages from the flake)</b></summary>
<br>

```sh
cd /etc/nixos                      # or wherever your flake is
nix flake update artcraft-nix      # just this input
sudo nixos-rebuild switch
```

`nix flake update` with no name updates every input, nixpkgs included.

</details>

<details>
<summary><b>Without flakes: <code>fetchTarball</code> of <code>main</code></b></summary>
<br>

Nix caches a tarball URL for an hour (`tarball-ttl`), then fetches it again
at the next rebuild. To update now:

```sh
sudo nixos-rebuild switch --option tarball-ttl 0
```

</details>

<details>
<summary><b>A pinned release, commit, or <code>npins</code>/<code>niv</code></b></summary>
<br>

Point the pin at the newer release (`…/archive/2026.11.22.2.tar.gz`, or
`github:boltflake/artcraft-nix/2026.11.22.2`) and rebuild. With npins or niv:

```sh
npins update artcraft-nix    # or: niv update artcraft-nix
sudo nixos-rebuild switch
```

</details>

<details>
<summary><b>A channel</b></summary>
<br>

If you added artcraft-nix as a channel
(`nix-channel --add https://github.com/boltflake/artcraft-nix/archive/main.tar.gz artcraft-nix`):

```sh
sudo nix-channel --update artcraft-nix   # or without sudo, for a user channel
sudo nixos-rebuild switch
```

</details>

<details>
<summary><b>A profile (<code>nix profile</code> or <code>nix-env</code>)</b></summary>
<br>

```sh
nix profile upgrade --all     # or the one entry: nix profile upgrade photocraft
# with nix-env, install it again from main:
nix-env -f https://github.com/boltflake/artcraft-nix/archive/main.tar.gz -iA photocraft
```

</details>

<details>
<summary><b>Home Manager</b></summary>
<br>

Update the input as for a flake (`nix flake update artcraft-nix` in your Home
Manager flake), then `home-manager switch`.

</details>

## What leaves your machine

artcraft-nix adds nothing and, by default, takes nothing away. From an audit
of the apps' code at their latest releases (2026-11-22):

- **The Craft Apps** use no telemetry or crash-report library. By default the
  only request they make on their own is the update check above: a `GET` to
  `api.github.com/repos/storytold/<app>/releases`, with no account or device
  identifier. GitHub sees your IP address and the app's name, and for
  AniCraft and Craft Anything their version. CADCraft checks only once its
  config folder exists; TextureCraft, EffectCraft and MaterialCraft skip it
  when started with `--control`. Font and model downloads happen only when
  you ask. Craft Anything, until its first-run setup is done, also looks for
  local AI servers (Ollama, LM Studio) on loopback, and any LAN servers
  configured for OpenCode.
- **ArtCraft Studio**, as shipped, even when nobody is signed in:
  - loads Google Analytics, Microsoft Clarity and Google Fonts in its window
    (see the next section to block the analytics);
  - checks the login with `api.storyteller.ai` at each start, and fetches the
    image and video model lists and the image cost from it;
  - polls Storyteller's job list while running: every 35 seconds when signed
    out (by its code, and timed on 2026-11-22);
  - tells a running Discord "Playing — Crafting Arts with ArtCraft" every 60
    seconds over Discord's local socket, so your Discord friends see it.

  Activity reports go to Storyteller only when you're signed in, and AI
  providers are called only when you act.
- **Listening:** PhotoCraft and VectorCraft listen on `127.0.0.1` on a random
  port, behind a token, so a second launch can hand files to the running app.
  PdfCraft uses a Unix socket in `$XDG_RUNTIME_DIR/pdfcraft/`. The control
  servers and FigCraft's live sharing (port 47900) listen only when you turn
  them on.
- **Written elsewhere:** Studio keeps its data in `~/Artcraft`, and a cookie
  store (your sign-in) in `~/.cache/ai.artcraft.app/.cookies`.
  Craft Anything's `setup` command, after asking, writes its CLI's
  `/nix/store/…` path into other tools' MCP configs (Claude Code, Codex,
  Cursor and others). That path stops working after an update and garbage
  collection, so point them at a path that stays put instead:
  `/run/current-system/sw/bin/craft-anything-cli` with the module, or
  `~/.nix-profile/bin/craft-anything-cli` (or your profile's path).
  Graphical clients may not see your shell's `PATH`, so a bare name isn't
  enough.
- **Not settled yet** (and said here until it is):
  - whether Studio's PostHog is inert (its Linux build seems to set no key);
  - whether the font store refreshes at start once enabled;
  - what Craft Anything's first-run scan of agent CLIs runs;
  - whether its managed engine installs ever start without you asking.

## Studio's analytics: `hostFileBlockAnalytics`

Studio's window loads Google Analytics (`www.googletagmanager.com/gtag/js`)
and Microsoft Clarity (`www.clarity.ms/tag/`) every time, and has no setting
for it. By default artcraft-nix leaves Studio exactly as upstream builds it.
If you'd rather it didn't load them, the module can block those two names in
your machine's hosts file:

```nix
programs.artcraft.hostFileBlockAnalytics = true;
```

**What it does.** It adds `www.googletagmanager.com` and `www.clarity.ms` to
`networking.hosts`, each at both `0.0.0.0` and `::`. It doesn't change
Studio at all. Both trackers' other scripts and collection hosts are only
reached through these two loaders, so blocking them is enough: in testing,
Google Analytics' own host was never looked up, because its loader never
arrived. It works whether your system resolves names through `/etc/hosts`
directly (NixOS's default) or through systemd-resolved, which treats those
entries as names with no address; a VM test checks both.

**Read this before you turn it on:**

- **It's machine-wide.** Every program and every user on the machine gets no
  address for those two names, browsers included. A website that relies on
  Google Tag Manager may misbehave on this machine. It applies whenever it's
  set, whatever `enable`, `apps` and `excludeApps` say.
- **It doesn't block** a proxy that resolves names itself (an HTTP proxy set
  for your session), a program with its own DNS over HTTPS, an address
  already cached or written as a literal, systemd-resolved with
  `ReadEtcHosts=no`, a name service order customised to ask DNS first, or the
  same name mapped to a real address elsewhere in your hosts configuration
  (`extraHosts`, `hostFiles`), which may win.
- **Clear Studio's web cache** for it to take effect at once: a copy of a
  loader cached before you turned the option on can still run until it
  expires (on 2026-11-22 Google's loader allowed caching for 15 minutes,
  `max-age=900`; Clarity's none). Quit Studio and delete
  `~/.local/share/ai.artcraft.app/WebKitCache`. Only that folder:
  `~/.cache/ai.artcraft.app` holds your sign-in.
- **On or off takes effect for new lookups** after the rebuild; Studio or a
  browser already running may keep old answers until restarted.
- **`0.0.0.0` and `::` mean this machine** when resolved through
  `/etc/hosts`, so a local server listening on port 443 would receive those
  connections. Tested with a server there that accepts them and never
  answers: Studio still started as quickly as without one.
- **It covers what the audited Studio version (0.41.1) uses.** Each new Studio
  release is checked for third-party hosts in its page that aren't in the
  list below; a new one opens an issue for review. Blocking more is a
  decision made here, never automatic.
- It doesn't touch Studio's Storyteller traffic, Google Fonts or Discord
  presence.

`artcraft-nix doctor` reports whether the block is complete, partial (a
name at only one of the two addresses, so lookups for the other address
family go to DNS) or absent, and warns if a proxy is configured.

**The list** (`shared/studio-hosts.json`):

| Host | Status | What |
| --- | --- | --- |
| `www.googletagmanager.com` | blocked by the option | Google Analytics' loader |
| `www.clarity.ms` | blocked by the option | Microsoft Clarity's loader |
| `www.google-analytics.com` | disclosed | Google Analytics' collection host, reached only through its loader |
| `*.clarity.ms` | disclosed | Clarity's collection hosts (lettered subdomains a hosts file can't match) |
| `api.storyteller.ai` | disclosed | Storyteller: the login check, model lists, image cost and job polling |
| `fonts.googleapis.com`, `fonts.gstatic.com` | disclosed | Google Fonts |
| `unpkg.com` | disclosed | detect-gpu's benchmark data |
| `us.i.posthog.com` | disclosed | PostHog, likely inert (still to be settled) |

**Without the module,** on NixOS (both lines are needed):

```nix
networking.hosts = {
  "0.0.0.0" = [ "www.googletagmanager.com" "www.clarity.ms" ];
  "::" = [ "www.googletagmanager.com" "www.clarity.ms" ];
};
```

On another system, add these lines to `/etc/hosts`:

```
0.0.0.0 www.googletagmanager.com www.clarity.ms
::      www.googletagmanager.com www.clarity.ms
```

## NixOS stable

`programs.artcraft.nixpkgs` picks the libraries the apps load (Mesa,
Wayland, X11, WebKitGTK for Studio, …). It doesn't change which app versions
you get.

| `nixpkgs` | Libraries |
| --- | --- |
| `"unstable"` (default) | the `nixos-unstable` this flake pins |
| `"stable"` | the current NixOS release (26.05 today), at the revision this flake pins and tests |

Without the module, the set is `artcraft-nix.legacyPackages.<system>.stable`.

**When to use it:** if an app has graphics problems, `"stable"` takes Mesa
from the same release as your system's GPU driver. It follows this flake's
pin, not your system, so you may still get a second copy of the libraries.

**It can lag.** When a new release fails a check only on NixOS stable, the
stable set stays on the last versions that passed there, and catches up once
everything passes. The status page shows when it's behind, and a
`stable-behind` issue says why.

## When something isn't working: `artcraft-nix doctor`

The module installs `artcraft-nix doctor`; without it, run
`nix run github:boltflake/artcraft-nix#doctor`. It checks:

- whether each app on your `PATH` is artcraft-nix's, or another copy that
  hides it (nixpkgs' own, a deb or rpm, a manual install);
- copies outside Nix that shadow the apps or confuse things: Flatpaks
  (`ai.storyteller.*`), AppImages in `~/Applications`, `~/AppImages` and
  `~/.local/bin`, the ArtCraft Launcher, and distribution packages;
- whether GL and Vulkan drivers are reachable (`/run/opengl-driver`, Vulkan
  ICDs), or on another distribution whether you're running under nixGL;
- whether a desktop portal answers on the session bus, or `zenity` is there,
  for file dialogs;
- Studio's analytics block in `/etc/hosts`, and proxies that bypass it.

```
$ artcraft-nix doctor
artcraft-nix doctor (this build: nixpkgs unstable)

The apps on PATH
  ok: photocraft: artcraft-nix's (photocraft 0.23.1)
  note: gridcraft at /run/current-system/sw/bin/gridcraft is another Nix package's (nixpkgs packages some of the apps too), not artcraft-nix's (…)

Copies outside Nix
  PROBLEM: AppImage /home/me/Applications/PhotoCraft-0.22.0-x86_64.AppImage
    -> it updates itself and can shadow the Nix app; delete it if artcraft-nix's is the one you use

Graphics drivers
  ok: GL drivers in /run/opengl-driver
  ok: Vulkan drivers: 2 ICD file(s)
…
1 problem(s) found.
```

It only reads: it changes nothing and needs no sudo. It exits with 1 if
there's a problem.

**Reporting problems.** A security problem goes in a private report, never
an issue: see [SECURITY.md](SECURITY.md). For anything else, run the doctor
first and do what it says; if that doesn't fix it,
[open an issue](https://github.com/boltflake/artcraft-nix/issues) with its
output, the artcraft-nix commit or release you're on, what you did and what
happened. A problem in an app itself, one that also happens without Nix,
belongs upstream, in that app's repository under
[storytold](https://github.com/storytold).

## Pinning and rolling back

**Pinning.** `main` moves with every update. To stay on one set of
versions, point the input at a release or a commit:

```nix
inputs.artcraft-nix.url = "github:boltflake/artcraft-nix/2026.11.22.1";
# or any commit: "github:boltflake/artcraft-nix/<commit>"
```

**Rolling back.**

- **The whole system:** boot an older generation, or
  `sudo nixos-rebuild switch --rollback`.
- **Only artcraft-nix:**

  ```sh
  cd /etc/nixos
  sudo nix flake lock --override-input artcraft-nix 'github:boltflake/artcraft-nix/2026.11.22.1'
  sudo nixos-rebuild switch
  ```

  The lock keeps that until your next `nix flake update`.
- **Without flakes:** import an older release's or commit's tarball instead
  of `main`'s.

**An older set may not download any more.** Every package is upstream's own
file, fetched from its GitHub release when you build. There's no binary
cache, so rebuilding an old version needs upstream to still have that
release. Booting an older generation needs none of this: its packages are
still in your store.

## Following new releases

Every update that changes an app's version gets a release here, named
`YYYY.MM.DD.N` (the date in UTC, and the number of that day's release).

- It lists every package at that commit and how to pin it, and every version
  change since the previous release, with links to upstream's release notes.
  Hand fixes made in between are listed too.
- A nixpkgs update alone gets no release.
- GitHub's Latest marker is on the newest release, also after a release
  upstream pulled made `main` go back to an earlier version.

To hear about them, use Watch → Custom → Releases on the repository page, or
the feed at <https://github.com/boltflake/artcraft-nix/releases.atom>.

**nixpkgs** (the libraries the apps load) moves to the newest
`nixos-unstable` after an app release (at most once a day), and at least once
a week. A move
waits until everything it needs is on cache.nixos.org, so you never compile
nixpkgs yourself, and it's tested like any release.

## Details

### Signatures

Every ArtCraft release carries `SHA256SUMS.txt` and its signature. A release
is pinned only if that signature is good and made by upstream's release key
(primary fingerprint `2B76741B414AAD6CD33E631213A005C0B9D7C3ED`, signing
subkey `568DC1F68F8FAECC797F3C7B006DAF6BB0EF334E`), and every tarball's
SHA-256 in it matches GitHub's checksum for that file; Nix then checks the
download against it.

The key is trusted on first use: it's the key attached to the releases on
GitHub, the same in all 18 repositories, and no source outside GitHub
publishes it. That protects you from a key that changes later (updates stop
until it's looked at), not from one that was already wrong on 2026-11-22.
A release that doesn't verify is held, and an issue opens.

### Unavailable packages

If upstream deletes a release's files, that package can't be built any more
(there's no binary cache to fall back on). The others carry on: the update
runs test and publish everything else, the package still evaluates but its
build fails with a message pointing at the issue, `default` and the module
leave it out (the module with a warning), and the status page shows it. It
comes back when upstream publishes a new release or restores the files.

### Supported systems

x86_64 and aarch64 Linux. Upstream also builds for riscv64, but there are no
GitHub runners to test it on. On macOS, `nix run` says Linux only.

## Maintainer notes

See [MAINTAINING.md](MAINTAINING.md) for how updates, tests, issues and
releases work, how to set it up, and how to add a package.

## License

The Nix code and scripts here are under the [MIT License](LICENSE). The apps
are storytold's, under MIT or Apache-2.0, with fonts under the SIL Open Font
License; each package installs their licence files.
