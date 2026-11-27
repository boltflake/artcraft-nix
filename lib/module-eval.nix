# module-eval: the NixOS module, evaluated on this nixpkgs (or NixOS
# stable's, onStable): defaults, apps, excludeApps, the companions,
# nixpkgs = "stable", unavailable packages, a typo in apps (which must fail),
# and analytics-hosts (hostFileBlockAnalytics, read from the evaluated
# config.networking.hosts). Every case is decided at evaluation; the
# derivation lists them and fails on any that don't hold.
{
  lib,
  runCommand,
  stdenv,
  pkgs,
  self,
  nixosPath,
  onStable ? false,
  # The package set under test: the flake's, or a NixOS-stable suite's (the
  # stable set, or stable-next's), which the module's nixpkgs = "stable"
  # then installs.
  set ? (
    if onStable then
      self.legacyPackages.${stdenv.hostPlatform.system}.stable
    else
      self.packages.${stdenv.hostPlatform.system}
  ),
}:
let
  inherit (stdenv.hostPlatform) system;
  names = import ./packages.nix;
  hostsList = lib.importJSON ../shared/studio-hosts.json;
  blocked = map (h: h.host) (builtins.filter (h: h.status == "blocked") hostsList.hosts);
  disclosed = map (h: h.host) (builtins.filter (h: h.status == "disclosed") hostsList.hosts);

  base = {
    boot.loader.grub.enable = false;
    fileSystems."/" = {
      device = "none";
      fsType = "tmpfs";
    };
    system.stateVersion = "26.05";
  };
  evalWith =
    module: cfg:
    (import "${nixosPath}/nixos/lib/eval-config.nix" {
      inherit system;
      modules = [
        module
        base
        cfg
      ];
    }).config;
  moduleFor =
    ours':
    import ../nixos/module.nix {
      packages.${system} = if onStable then self.packages.${system} else ours';
      stable.${system} = if onStable then ours' else { };
    };
  eval = evalWith (moduleFor set);
  # The same configuration without the module (its options' values unset).
  evalPlain = cfg: evalWith { } cfg;

  setName = if onStable then "stable" else "unstable";
  stableOpt = lib.optionalAttrs onStable { programs.artcraft.nixpkgs = "stable"; };
  ours = set;
  # Today's availability: a package whose files upstream deleted is never
  # installed, so the expectations leave it out.
  available = n: ours ? ${n} && !(ours.${n}.meta.unavailable or false);
  desktop = builtins.filter available names.desktop;
  someApp = lib.findFirst available "gridcraft" names.appNames;
  installedNames =
    config:
    lib.sort (a: b: a < b) (
      map lib.getName (
        builtins.filter (
          p: builtins.elem (lib.getName p) (names.all ++ [ "artcraft-nix" ])
        ) config.environment.systemPackages
      )
    );
  sorted = lib.sort (a: b: a < b);
  expectInstalled = ns: sorted (ns ++ [ "artcraft-nix" ]);

  hostsOf = config: config.networking.hosts;
  fails = v: !(builtins.tryEval (builtins.deepSeq v v)).success;

  # The gate with real markers (pins merged by lib/versions.nix): a desktop
  # app, Studio and a companion, as the update run would publish them.
  marker = p: {
    unavailable = {
      since = "2026-11-22T00:00:00Z";
      issue = null;
      packages = p;
    };
  };
  marked = import ../pkgs {
    inherit pkgs;
    pinsDir = if onStable then ../versions/stable else ../versions;
    nixpkgs = if onStable then "stable" else "unstable";
    pinsOverlay = {
      gridcraft = marker [ "gridcraft" ];
      artcraft = marker [ "artcraft-studio" ];
      figcraft = marker [ "figcraft-server" ];
    };
  };
  goneCfg = evalWith (moduleFor marked) (
    lib.recursiveUpdate stableOpt {
      programs.artcraft.enable = true;
      programs.artcraft.apps = [
        "photocraft"
        "gridcraft"
        "artcraft-studio"
        "figcraft"
        "figcraft-server"
      ];
    }
  );

  on = cfg: eval (lib.recursiveUpdate stableOpt cfg);
  userHosts = {
    networking.hosts."0.0.0.0" = [ "ads.example" ];
    networking.hosts."::" = [ "ads.example" ];
    networking.hosts."127.0.0.2" = [ "mine.example" ];
  };

  cases = {
    "defaults: every desktop app, Studio and the doctor (${setName})" =
      installedNames (on {
        programs.artcraft.enable = true;
      }) == expectInstalled desktop;
    "defaults: hardware.graphics on" =
      (on { programs.artcraft.enable = true; }).hardware.graphics.enable;
    "only the headless companions: no hardware.graphics" =
      !(on {
        programs.artcraft = {
          enable = true;
          apps = [
            "pdfcraft-cli"
            "figcraft-server"
          ];
        };
      }).hardware.graphics.enable;
    "apps: only those, companions included" =
      installedNames (on {
        programs.artcraft.enable = true;
        programs.artcraft.apps = [
          someApp
          "pdfcraft-cli"
          "figcraft-server"
        ];
      }) == expectInstalled (
        builtins.filter available [
          "figcraft-server"
          "pdfcraft-cli"
          someApp
        ]
      );
    "excludeApps: leaves Studio out" =
      installedNames (on {
        programs.artcraft.enable = true;
        programs.artcraft.excludeApps = [ "artcraft-studio" ];
      }) == expectInstalled (lib.remove "artcraft-studio" desktop);
    "disabled: installs nothing" =
      installedNames (on {
        programs.artcraft.apps = [ "photocraft" ];
      }) == [ ];
    "a typo in apps fails evaluation" =
      fails
        (on {
          programs.artcraft.enable = true;
          programs.artcraft.apps = [ "photocraf" ];
        }).environment.systemPackages;
    "the packages come from the ${setName} set" =
      let
        c = on {
          programs.artcraft.enable = true;
          programs.artcraft.apps = [ someApp ];
        };
        p = lib.findFirst (x: lib.getName x == someApp) null c.environment.systemPackages;
      in
      p != null && p.drvPath == ours.${someApp}.drvPath;
    "unavailable (real markers): left out with a warning, also when apps names them; the rest install" =
      installedNames goneCfg == expectInstalled (
        builtins.filter available [
          "figcraft"
          "photocraft"
        ]
      )
      && lib.all (n: builtins.any (w: lib.hasInfix "${n} isn't installed" w) goneCfg.warnings) [
        "gridcraft"
        "artcraft-studio"
        "figcraft-server"
      ];
    "unavailable (real markers): `default` leaves them out, and the doctor and the stubs evaluate" =
      let
        inDefault = marked.default.passthru.packages;
      in
      !builtins.elem "gridcraft" inDefault
      && !builtins.elem "artcraft-studio" inDefault
      && lib.hasSuffix ".drv" marked.doctor.drvPath
      &&
        lib.all
          (
            n:
            marked.${n}.meta.unavailable
            && lib.hasSuffix ".drv" marked.${n}.drvPath
            && marked.${n}.version != ""
          )
          [
            "gridcraft"
            "artcraft-studio"
            "figcraft-server"
          ];

    # analytics-hosts
    "analytics-hosts: on adds exactly the blocked names at 0.0.0.0 and ::" =
      let
        h = hostsOf (on {
          programs.artcraft.hostFileBlockAnalytics = true;
        });
        plain = hostsOf (evalPlain { });
      in
      sorted (h."0.0.0.0" or [ ]) == sorted ((plain."0.0.0.0" or [ ]) ++ blocked)
      && sorted (h."::" or [ ]) == sorted ((plain."::" or [ ]) ++ blocked);
    "analytics-hosts: blocks nothing disclosed" =
      let
        h = hostsOf (on {
          programs.artcraft.hostFileBlockAnalytics = true;
        });
      in
      !builtins.any (n: builtins.any (addr: builtins.elem n addr) (builtins.attrValues h)) disclosed;
    "analytics-hosts: applies with enable = false and with Studio excluded" =
      let
        a = hostsOf (on {
          programs.artcraft.hostFileBlockAnalytics = true;
        });
        b = hostsOf (on {
          programs.artcraft.enable = true;
          programs.artcraft.excludeApps = [ "artcraft-studio" ];
          programs.artcraft.hostFileBlockAnalytics = true;
        });
      in
      a == b && lib.all (n: builtins.elem n (a."0.0.0.0" or [ ])) blocked;
    "analytics-hosts: the user's own entries survive" =
      let
        h = hostsOf (
          on (lib.recursiveUpdate userHosts { programs.artcraft.hostFileBlockAnalytics = true; })
        );
      in
      builtins.elem "ads.example" h."0.0.0.0"
      && builtins.elem "ads.example" h."::"
      && builtins.elem "mine.example" h."127.0.0.2"
      && lib.all (n: builtins.elem n h."0.0.0.0" && builtins.elem n h."::") blocked;
    "analytics-hosts: off adds nothing" =
      hostsOf (on {
        programs.artcraft.enable = true;
      }) == hostsOf (evalPlain { })
      && hostsOf (on userHosts) == hostsOf (evalPlain userHosts);
  };
  failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) cases);
in
runCommand "module-eval" { } (
  lib.concatMapStrings (n: "echo ${lib.escapeShellArg "ok: ${n}"}\n") (builtins.attrNames cases)
  + (
    if failed == [ ] then
      "touch $out\n"
    else
      lib.concatMapStrings (n: "echo ${lib.escapeShellArg "FAILED: ${n}"}\n") failed + "exit 1\n"
  )
)
