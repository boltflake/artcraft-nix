# Security

## Reporting a vulnerability

Please report security problems privately, never in a public issue:
[report a vulnerability](https://github.com/boltflake/artcraft-nix/security/advisories/new)
(the repository's Security tab, "Report a vulnerability"). Include:

- what you found, its impact, and how to reproduce it
- what's affected, if you know: the package, and whether it's the
  [NixOS stable](README.md#nixos-stable) set
- the artcraft-nix commit or release you're on: `nix flake metadata
  /etc/nixos` (or your flake's folder) lists it; otherwise the flake ref or
  tarball URL you used

For a confirmed vulnerability, when and how the advisory is published is
agreed with you, with credit to you unless you'd rather stay anonymous.

## What belongs here

Anything this repository makes, for example:

- the packaging: the wrappers, the patching of upstream's builds, the pins
  and the hashes and signatures they check, the NixOS module and its
  `hostFileBlockAnalytics` option, the doctor
- the update workflows, the release watcher and its deployment: anything
  that could get unchecked files onto `main` or into a release, including
  the signature check and the trusted key (`keys/`)

A vulnerability in an ArtCraft app itself, one that also happens without
Nix, goes to that app's repository under
[storytold](https://github.com/storytold). Fixed releases reach this flake
through the same update runs and tests as any release. If upstream has fixed
it but this flake still ships the vulnerable version (the
[NixOS stable](README.md#nixos-stable) set can lag, and a held release stays
held), that belongs here, as a private report too.

## Supported versions

Only `main`. Fixes aren't backported to older commits or releases. To get
one:

- if you follow `main`, update the input (`nix flake update artcraft-nix`)
  and rebuild ([other setups](README.md#updating))
- if you pinned a release or a commit, move the pin to one that has the fix
- for `nix run`, run it again with `--refresh` before the flake ref
