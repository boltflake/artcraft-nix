# Every package this flake ships, built on the given pkgs. Used for the
# flake's own outputs (pinned nixpkgs), by the overlay (the user's), and for
# the NixOS-stable sets (the nixpkgs-stable pin, with the snapshot's pins).
# pinsDir: where the pins are read from; a package whose repository has no
# pin there isn't in the set.
# nixpkgs: which nixpkgs this set is, for the doctor to name.
{
  pkgs,
  pinsDir ? ../versions,
  nixpkgs ? "unstable",
  # Merged into the pins, by repository (lib/versions.nix): for checks only.
  pinsOverlay ? { },
}:
let
  inherit (pkgs) lib;
  versions = import ../lib/versions.nix { inherit lib pinsDir pinsOverlay; };
  callPackage = lib.callPackageWith (pkgs // { inherit versions; });
  names = import ../lib/packages.nix;
  inherit (names) entries repoOf companions;

  # builtins: the set's names must not need `pkgs` (listing the NixOS-stable
  # set's names would otherwise fetch its nixpkgs).
  apps = builtins.mapAttrs (
    name: entry:
    callPackage ./craft-app.nix {
      inherit name entry;
      dlopenCommon = entries.dlopen.common;
    }
  ) entries.apps;

  all = apps // {
    artcraft-studio = callPackage ./artcraft-studio/package.nix { };
    pdfcraft-cli = callPackage ./pdfcraft-cli/package.nix { };
    figcraft-server = callPackage ./figcraft-server/package.nix { };
  };
  # Builtins only: the set's names never need this pkgs to evaluate a
  # package (so listing the NixOS-stable set never fetches its nixpkgs).
  # (Through the overlay, `pkgs` is the final package set, whose names
  # depend on these: nothing here may touch `pkgs` or its lib.)
  pinned = builtins.filter (n: builtins.pathExists (pinsDir + "/${repoOf.${n}}.json")) (
    builtins.attrNames all
  );
  set = builtins.intersectAttrs (builtins.listToAttrs (
    map (n: {
      name = n;
      value = null;
    }) pinned
  )) all;

  # Every desktop app and Studio, leaving out the companions and any
  # package whose release files upstream deleted.
  desktop = lib.filterAttrs (n: p: !builtins.elem n companions && !(p.meta.unavailable or false)) set;

  tools = {
    # `artcraft-nix doctor` and `artcraft-nix-init`.
    doctor = callPackage ./doctor/package.nix {
      inherit nixpkgs;
      packages = set;
    };
    init = callPackage ./init/package.nix { };
  };
in
set
// tools
// {
  default = pkgs.buildEnv {
    name = "artcraft-suite";
    paths = builtins.attrValues desktop;
    pathsToLink = [
      "/bin"
      "/share"
    ];
    passthru = {
      packages = builtins.attrNames desktop;
    };
    meta = {
      description = "Every ArtCraft desktop app and ArtCraft Studio";
      platforms = lib.platforms.linux;
    };
  };
}
