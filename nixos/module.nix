# programs.artcraft for NixOS (the flake's nixosModules.default).
#
#   packages: this flake's own packages, by system
#   stable:   the NixOS-stable set (legacyPackages.<system>.stable), by system
{
  packages,
  stable ? { },
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.artcraft;
  inherit (pkgs.stdenv.hostPlatform) system;
  names = import ../lib/packages.nix;
  hostsList = lib.importJSON ../shared/studio-hosts.json;
  # The names hostFileBlockAnalytics puts in /etc/hosts: the `blocked`
  # entries only.
  blocked = map (h: h.host) (builtins.filter (h: h.status == "blocked") hostsList.hosts);

  ours =
    (if cfg.nixpkgs == "stable" then stable else packages).${system}
      or (throw "programs.artcraft: artcraft-nix supports Linux only (x86_64 and aarch64), not ${system}");

  # What enable installs: every desktop app and Studio, or `apps`, less
  # `excludeApps`.
  chosen = builtins.filter (n: !builtins.elem n cfg.excludeApps) (
    if cfg.apps == null then names.desktop else cfg.apps
  );
  isUnavailable = n: !(ours ? ${n}) || (ours.${n}.meta.unavailable or false);
  unavailable = builtins.filter isUnavailable chosen;
  installed = map (n: ours.${n}) (builtins.filter (n: !isUnavailable n) chosen);
  appName = lib.types.enum names.all;
in
{
  _file = ./module.nix;

  options.programs.artcraft = {
    enable = lib.mkEnableOption "the ArtCraft apps (every desktop app and ArtCraft Studio, unless `apps` says otherwise)";

    apps = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf appName);
      default = null;
      example = [
        "photocraft"
        "pdfcraft"
        "pdfcraft-cli"
      ];
      description = ''
        The packages to install, by name: any of the desktop apps,
        `artcraft-studio`, and the companions `pdfcraft-cli` and
        `figcraft-server`. `null` installs every desktop app and Studio. A
        name that isn't one of this flake's packages fails evaluation.
      '';
    };

    excludeApps = lib.mkOption {
      type = lib.types.listOf appName;
      default = [ ];
      example = [ "artcraft-studio" ];
      description = "Packages to leave out of what `apps` (or its default) installs.";
    };

    nixpkgs = lib.mkOption {
      type = lib.types.enum [
        "unstable"
        "stable"
      ];
      default = "unstable";
      description = ''
        Whose libraries the apps load: `"unstable"` (this flake's
        nixos-unstable, the default) or `"stable"` (the NixOS release this
        flake tests). The same apps either way, normally at the same
        versions; NixOS stable can be a release behind when one fails only
        there. See the README, "NixOS stable".
      '';
    };

    hostFileBlockAnalytics = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Block the analytics loaders ArtCraft Studio's window loads (Google
        Analytics' `www.googletagmanager.com` and Microsoft Clarity's
        `www.clarity.ms`) by pointing them at `0.0.0.0` and `::` in
        `networking.hosts`.

        This affects every program and every user on the machine, browsers
        included: a website that relies on Google Tag Manager may misbehave
        here. It applies whenever it's set, whatever `enable`, `apps` and
        `excludeApps` say. It doesn't apply to programs that resolve names
        themselves (an HTTP proxy, DNS over HTTPS), and an earlier copy of a
        loader in Studio's WebKit cache can still run until you delete
        `~/.local/share/ai.artcraft.app/WebKitCache`. See the README,
        "Studio's analytics".
      '';
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      environment.systemPackages = installed ++ [ ours.doctor ];
      # The apps draw with GL or Vulkan; the two headless companions don't,
      # so a server with only those gets no graphics stack.
      hardware.graphics.enable = lib.mkIf (lib.any (n: !lib.elem n names.companions) (
        builtins.filter (n: !isUnavailable n) chosen
      )) (lib.mkDefault true);
      warnings = map (
        n:
        "programs.artcraft: ${n} isn't installed: ${
          if ours ? ${n} then
            "upstream deleted its release files (${
              ours.${n}.passthru.unavailable.since or "recently"
            }); see the artcraft-nix status page"
          else
            "it isn't in the ${cfg.nixpkgs} set yet"
        }."
      ) unavailable;
    })
    (lib.mkIf cfg.hostFileBlockAnalytics {
      networking.hosts = {
        "0.0.0.0" = blocked;
        "::" = blocked;
      };
      # The doctor's sign that this machine asked for the block (it then
      # reports a partial one as a problem, not a note).
      environment.etc."artcraft-nix/analytics-block".text = "${toString blocked}\n";
    })
  ];
}
