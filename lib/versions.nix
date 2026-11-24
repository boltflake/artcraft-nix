# Reads a repository release's pin from versions/<repo>.json. Only the
# updater (scripts/update.ts) and scripts/pin.ts write those files, with the
# same verifier (scripts/lib/verify.ts). A pin covers every package from that
# release: per package and system the versioned URL, its SRI hash, and the
# upstream asset's ID and digest.
# pinsDir: versions/ for the flake's own outputs, versions/stable/ (the
# snapshot) for the NixOS-stable set.
{
  lib,
  pinsDir ? ../versions,
  # Attributes merged into a repository's pin, by repository (the checks use
  # it to evaluate the gate with real `unavailable` markers).
  pinsOverlay ? { },
}:
let
  load = repo: lib.importJSON (pinsDir + "/${repo}.json") // (pinsOverlay.${repo} or { });
in
rec {
  inherit load;
  # Whether this pins folder has the repository's pin (a package without
  # its pin isn't in the set built from it).
  has = repo: builtins.pathExists (pinsDir + "/${repo}.json");

  # The fetchurl arguments for one package and system, or a clear error if
  # upstream ships nothing for it.
  asset =
    pin: pkg: system:
    let
      a =
        pin.packages.${pkg}.${system}
          or (throw "${pkg} ${pin.version} has no release for ${system} (see docs/acceptance-matrix.md)");
    in
    {
      inherit (a) url hash;
    };

  # The systems a package's pin has assets for, for meta.platforms.
  platforms = pin: pkg: builtins.attrNames pin.packages.${pkg};

  # The marker resolve writes when a pinned asset is confirmed gone
  # ("Unavailable packages"), or null.
  unavailable =
    pin: pkg:
    let
      u = pin.unavailable or null;
    in
    if u != null && builtins.elem pkg (u.packages or [ ]) then u else null;

  # What every wrapper does (see pkgs/craft-app.nix): the one shown need,
  # unsetting APPIMAGE, and the managed-update hint from
  # storytold/craft-libs#2975, which app versions without it ignore.
  managedHint = "Update your Nix sources and rebuild to get the new version.";
  wrapperArgs = [
    "--unset"
    "APPIMAGE"
    "--set"
    "CRAFT_UPDATE_MANAGED_BY"
    "Nix"
    "--set"
    "CRAFT_UPDATE_MANAGED_HINT"
    managedHint
  ];

  # A package whose pinned asset upstream deleted: it still evaluates, and
  # building it fails with the marker's message and its issue.
  unavailableDrv =
    {
      pname,
      version,
      marker,
      system,
      bins ? [ pname ],
    }:
    derivation {
      name = "${pname}-${version}-unavailable";
      inherit system;
      builder = "/bin/sh";
      args = [
        "-c"
        "echo ${lib.escapeShellArg "${pname} ${version} is unavailable: upstream deleted its release files (since ${marker.since}). See ${if marker.issue or null != null then "https://github.com/boltflake/artcraft-nix/issues/${toString marker.issue}" else "https://github.com/boltflake/artcraft-nix/issues?q=is%3Aissue+is%3Aopen+label%3Aartcraft-nix+unavailable"}."} >&2; exit 1"
      ];
    }
    // {
      inherit pname version;
      # What the doctor, the module and `nix run` read from a package.
      meta = {
        unavailable = true;
        description = "${pname} (unavailable)";
        mainProgram = builtins.head bins;
        platforms = [ system ];
      };
      passthru = {
        unavailable = marker;
        inherit bins;
        files = [ ];
      };
    };

  # The install check every package runs: each binary's --version, with only
  # a fresh HOME and TMPDIR and no display, gives the pinned version and
  # exits 0.
  installCheck = bins: {
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      export HOME=$(mktemp -d) TMPDIR=$(mktemp -d)
      for b in ${lib.escapeShellArgs bins}; do
        status=0
        output=$(env --chdir=/ --ignore-environment HOME="$HOME" TMPDIR="$TMPDIR" "$out/bin/$b" --version 2>&1) || status=$?
        if [ "$status" -ne 0 ]; then echo "$b --version exited with status $status: $output" >&2; exit 1; fi
        # The exact version, not one that contains it (1.2.3 in 11.2.30).
        if ! grep -Eq "(^|[^0-9.])''${version//./\\.}([^0-9.]|$)" <<< "$output"; then echo "$b --version doesn't report $version: $output" >&2; exit 1; fi
        echo "$b --version reports $version"
      done
      runHook postInstallCheck
    '';
  };
}
