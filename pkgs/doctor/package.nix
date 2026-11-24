# `artcraft-nix doctor`: why isn't an ArtCraft app working? Read-only
# (doctor.sh). What it compares against is this build's: each package's
# version, store path and programs, and the analytics names the module can
# block. Store paths are written as plain strings (their context dropped),
# so the doctor doesn't depend on the apps: `nix run .#doctor` fetches a
# shell script, not every app.
{
  lib,
  writeShellApplication,
  writeText,
  coreutils,
  gnugrep,
  gnused,
  findutils,
  dbus,
  packages,
  nixpkgs ? "unstable",
}:
let
  plain = p: builtins.unsafeDiscardStringContext (toString p);
  names = import ../../lib/packages.nix;
  hostsList = lib.importJSON ../../shared/studio-hosts.json;
  blocked = map (h: h.host) (builtins.filter (h: h.status == "blocked") hostsList.hosts);
  rows = map (
    n:
    let
      p = packages.${n};
    in
    "${n} ${p.version} ${if p.meta.unavailable or false then "-" else plain p} ${
      toString (p.passthru.bins or [ p.meta.mainProgram ])
    }"
  ) (builtins.filter (n: packages ? ${n}) names.all);
  data = writeText "artcraft-nix-doctor-data" ''
    NIXPKGS=${lib.escapeShellArg nixpkgs}
    PACKAGES=${lib.escapeShellArg (lib.concatStringsSep "\n" rows)}
    BLOCKED=${lib.escapeShellArg (toString blocked)}
    COMPANIONS=${lib.escapeShellArg (toString names.companions)}
  '';
in
writeShellApplication {
  name = "artcraft-nix";
  runtimeInputs = [
    coreutils
    gnugrep
    gnused
    findutils
  ];
  # flatpak, gsettings and zenity are the system's own; dbus-send too, with
  # nixpkgs' as a fallback at the end of PATH.
  inheritPath = true;
  text = ''
    case ''${1:-} in
      # No argument runs it too: `nix run .#doctor` has none.
      doctor) shift ;;
      "") ;;
      -h | --help) echo "usage: artcraft-nix doctor"; exit 0 ;;
      *) echo "artcraft-nix: unknown command ''${1}; try: artcraft-nix doctor" >&2; exit 2 ;;
    esac
    PATH="$PATH:${dbus}/bin"
  ''
  + builtins.replaceStrings [ "@data@" ] [ "${data}" ] (builtins.readFile ./doctor.sh);
  passthru = { inherit data; };
  meta = {
    description = "Finds why an ArtCraft app from artcraft-nix isn't working";
    mainProgram = "artcraft-nix";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
