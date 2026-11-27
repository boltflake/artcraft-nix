{
  description = "Every ArtCraft app for NixOS, updated minutes after each upstream release";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      # Not supported: `nix run` there says so (lib/unsupported.nix).
      otherSystems = [
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      names = import ./lib/packages.nix;

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          # Nothing from the user's nixpkgs config (default.nix is impure).
          overlays = [ ];
          config = { };
        };

      # NixOS stable (programs.artcraft.nixpkgs = "stable"): the nixos-NN.MM
      # revision versions/nixpkgs-stable.json pins, fetched only when used.
      stablePin = lib.importJSON ./versions/nixpkgs-stable.json;
      stableSrc = builtins.fetchTarball {
        url = "https://github.com/NixOS/nixpkgs/archive/${stablePin.rev}.tar.gz";
        sha256 = stablePin.narHash;
      };
      stablePkgsFor =
        system:
        import stableSrc {
          inherit system;
          overlays = [ ];
          config = { };
        };
      # The stable set users get: the snapshot's pins (versions/stable/).
      stableFor =
        system:
        import ./pkgs {
          pkgs = stablePkgsFor system;
          pinsDir = ./versions/stable;
          nixpkgs = "stable";
        };
      # What a snapshot move would give (the stable-next checks): the
      # current pins on NixOS stable.
      stableNextFor =
        system:
        import ./pkgs {
          pkgs = stablePkgsFor system;
          nixpkgs = "stable";
        };

      packageChecks =
        pkgs: packages:
        lib.filterAttrs (_: lib.isDerivation) (
          pkgs.callPackage ./lib/package-checks.nix { inherit packages; }
        );
      # A NixOS-stable suite: every package check of the set, plus the module
      # on it, each named <prefix><check>.
      suiteFor =
        system: prefix: set:
        lib.mapAttrs' (n: v: lib.nameValuePair "${prefix}${n}" v) (
          packageChecks (stablePkgsFor system) set
          // {
            # The module with nixpkgs = "stable", installing this suite's set
            # (stable-next's module check tests the pins it would move to).
            module-eval = (stablePkgsFor system).callPackage ./lib/module-eval.nix {
              inherit self set;
              nixosPath = stableSrc;
              onStable = true;
            };
          }
        );
    in
    {
      # Every package under pkgs.artcraft-nix; the apps also at the top level,
      # but never over a different nixpkgs program of the same name
      # (lib/overlay.nix). `default` is a flake-output convention, not a
      # package name.
      overlays.default =
        final: prev:
        let
          ours = removeAttrs (import ./pkgs { pkgs = final; }) [ "default" ];
          rules = import ./lib/overlay.nix;
          topLevel = builtins.filter (
            name: !(prev ? ${name}) || builtins.elem name rules.sameAsNixpkgs
          ) rules.candidates;
        in
        {
          artcraft-nix = ours;
        }
        # Names from the pin files alone: the final set's names can't depend
        # on evaluating it.
        // lib.genAttrs (builtins.filter (
          n: builtins.pathExists (./versions + "/${names.repoOf.${n}}.json")
        ) topLevel) (n: ours.${n});

      packages =
        forAllSystems (system: import ./pkgs { pkgs = pkgsFor system; })
        // lib.genAttrs otherSystems (system: {
          default = import ./lib/unsupported.nix system;
        });

      # Plain `nix run` names the apps and exits non-zero: there is no single
      # ArtCraft program. `nix run .#<app>` runs one.
      apps = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = {
            type = "app";
            meta.description = "Lists the apps to run";
            program = toString (
              pkgs.writeShellScript "artcraft-nix-apps" ''
                echo "artcraft-nix has one program per app. Run one of them:" >&2
                for a in ${lib.escapeShellArgs (names.all ++ [ "doctor" ])}; do
                  echo "  nix run github:boltflake/artcraft-nix#$a" >&2
                done
                exit 1
              ''
            );
          };
        }
      );

      nixosModules = rec {
        artcraft = import ./nixos/module.nix {
          inherit (self) packages;
          # programs.artcraft.nixpkgs = "stable": only evaluated when chosen.
          stable = lib.mapAttrs (_: l: l.stable) self.legacyPackages;
        };
        default = artcraft;
      };

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        packageChecks pkgs self.packages.${system}
        // lib.filterAttrs (_: lib.isDerivation) (
          pkgs.callPackage ./lib/checks.nix {
            inherit self;
            packages = self.packages.${system};
          }
        )
      );

      # `nix flake init -t github:boltflake/artcraft-nix`: a NixOS flake with
      # the module (templates/default; checked by `template`).
      templates.default = {
        path = ./templates/default;
        description = "A NixOS system with the ArtCraft apps from artcraft-nix";
        welcomeText = ''
          Wrote flake.nix: a NixOS system with the ArtCraft apps. It imports
          your ./configuration.nix. Check its nixpkgs line (see the comment
          there), then run:

          ```
          sudo nixos-rebuild switch --flake /etc/nixos#nixos
          ```
        '';
      };

      legacyPackages = forAllSystems (system: {
        # NixOS stable (programs.artcraft.nixpkgs = "stable"). Not evaluated
        # by `nix flake show` or `nix flake check`, so nothing fetches the
        # stable nixpkgs unless it's used.
        stable = removeAttrs (stableFor system) [ "default" ];
        # Internal, for CI only, one level down: `nix search` looks at each
        # top-level attribute here, and these would make every search fetch
        # and evaluate NixOS stable's nixpkgs.
        ci = {
          # The stable-next set, for the stable-next checks.
          stableNext = removeAttrs (stableNextFor system) [ "default" ];
          # The NixOS-stable suites, built apart from `checks` (by
          # scripts/ci/stable.ts), so nothing about NixOS stable can fail or
          # delay the default checks.
          stableChecks = suiteFor system "stable-" (stableFor system);
          stableNextChecks = suiteFor system "stable-next-" (stableNextFor system);
          # Too heavy for `checks` (it needs KVM): the hosts file through
          # glibc and systemd-resolved (lib/vm-test.nix).
          vmTests.resolver = import ./lib/vm-test.nix {
            inherit self;
            pkgs = pkgsFor system;
          };
          # A one-off probe of the block's local-machine side effect
          # (lib/vm-studio-probe.nix); not in any suite.
          vmTests.studioLoopback = import ./lib/vm-studio-probe.nix {
            inherit self;
            pkgs = pkgsFor system;
          };
        };
      });

      # `nix fmt` formats every .nix file (the nix-format check's nixfmt).
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
