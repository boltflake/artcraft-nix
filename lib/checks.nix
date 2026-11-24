# The flake-wide checks (the default suite's other part), as in
# t3code-nix. They run in the Nix sandbox: no network, loopback only.
{
  lib,
  runCommand,
  fetchurl,
  nodejs_26,
  typescript,
  git,
  stdenv,
  pkgs,
  path,
  self,
  stableSrc,
  packages,
}:
let
  names = import ./packages.nix;
  inherit (stdenv.hostPlatform) system;
  # A check from conditions decided at evaluation: each listed, failing on
  # any that doesn't hold.
  conditions =
    name: cases: extra:
    let
      failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) cases);
    in
    runCommand name { } (
      lib.concatMapStrings (
        n: "echo ${lib.escapeShellArg "${if cases.${n} then "ok" else "FAILED"}: ${n}"}\n"
      ) (builtins.attrNames cases)
      + extra
      + (if failed == [ ] then "touch $out\n" else "exit 1\n")
    );
  fails = v: !(builtins.tryEval (builtins.deepSeq v v)).success;
  available = n: packages ? ${n} && !(packages.${n}.meta.unavailable or false);
  releasePackages = builtins.filter available names.all;
  desktopAvailable = builtins.filter available names.desktop;

  # `default` itself, built in a part of its own in every test set that can
  # publish (the candidate, the final tree and branch CI).
  default-build = packages.default;

  # No two packages in `default` declare the same path, anywhere in the
  # tree, by buildEnv's merge rules. It compares the declared file lists,
  # which each package's n-files check proves true, so it downloads nothing.
  aggregate = runCommand "aggregate" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    python3 ${./files.py} aggregate ${
      builtins.toFile "declared.json" (
        builtins.toJSON (lib.genAttrs desktopAvailable (n: packages.${n}.passthru.files))
      )
    }
    touch $out
  '';

  module-eval = pkgs.callPackage ./module-eval.nix {
    inherit self;
    nixosPath = path;
  };

  no-self-rev = runCommand "no-self-rev" { } ''
    # The flake's own revision only (a fetcher's `rev = …` is fine).
    if grep -rnE '\b(self|sourceInfo)\.(rev|shortRev|dirtyRev|dirtyShortRev|lastModified|lastModifiedDate|narHash)\b|\bsourceInfo\b' \
        ${../flake.nix} ${../pkgs} ${../nixos} \
        $(find ${./.} -name '*.nix' ! -name checks.nix); then
      echo "the Nix code above refers to the flake's revision"; exit 1
    fi
    touch $out
  '';

  # The overlay never puts one of ours over a different nixpkgs program of
  # the same name (lib/overlay.nix).
  overlay =
    let
      rules = import ./overlay.nix;
      plain = import path {
        inherit system;
        overlays = [ ];
      };
      overlaid = import path {
        inherit system;
        overlays = [ self.overlays.default ];
      };
      drv = p: p.drvPath;
      ours = n: drv packages.${n};
      storytold =
        n:
        lib.hasPrefix "https://github.com/storytold/${names.repoOf.${n}}" (plain.${n}.meta.homepage or "");
    in
    conditions "overlay" {
      "every package is a candidate or kept out of the top level" =
        lib.sort (a: b: a < b) (rules.candidates ++ rules.notTopLevel)
        == lib.sort (a: b: a < b) (builtins.attrNames (removeAttrs packages [ "default" ]));
      "everything is under pkgs.artcraft-nix, as the flake builds it" = lib.all (
        n: drv overlaid.artcraft-nix.${n} == ours n
      ) releasePackages;
      "a name nixpkgs doesn't have is ours at the top level" = lib.all (n: drv overlaid.${n} == ours n) (
        builtins.filter (n: !(plain ? ${n})) releasePackages
      );
      "a name nixpkgs has is ours only when it's the same program (storytold's)" = lib.all (
        n:
        if builtins.elem n rules.sameAsNixpkgs then
          storytold n && drv overlaid.${n} == ours n
        else
          drv overlaid.${n} == drv plain.${n}
      ) (builtins.filter (n: plain ? ${n}) releasePackages);
      "every name kept as nixpkgs' is storytold's there" = lib.all (
        n: !(plain ? ${n}) || storytold n
      ) rules.sameAsNixpkgs;
      "the tools stay off the top level" = lib.all (
        n: !(overlaid ? ${n}) || drv overlaid.${n} == drv plain.${n}
      ) rules.notTopLevel;
    } "";

  # default.nix, as `nix-env -f`, `import (fetchTarball …)` and a
  # channel-based NixOS configuration use it: the same packages, module and
  # overlay as the flake's.
  no-flakes =
    let
      plain = import ../default.nix { inherit system; };
      nixos =
        (import (path + "/nixos/lib/eval-config.nix") {
          system = null;
          modules = [
            plain.nixosModules.default
            {
              nixpkgs.pkgs = pkgs;
              programs.artcraft.enable = true;
              boot.loader.grub.enable = false;
              fileSystems."/" = {
                device = "none";
                fsType = "tmpfs";
              };
              system.stateVersion = "26.05";
            }
          ];
        }).config;
      overlaid = import path {
        inherit system;
        overlays = [ plain.overlays.default ];
      };
      drv = p: p.drvPath;
    in
    conditions "no-flakes" {
      "this system's packages are the flake's, at the top level" = lib.all (
        n: drv plain.${n} == drv packages.${n}
      ) (releasePackages ++ names.tools);
      "every flake output is there; `default` is `suite`" =
        plain.flake ? nixosModules
        && plain.flake ? overlays
        && !(plain ? default)
        && drv plain.suite == drv packages.default;
      "its NixOS module installs the apps" =
        let
          some = lib.findFirst (n: available n) null names.desktop;
        in
        some != null && builtins.elem packages.${some}.drvPath (map drv nixos.environment.systemPackages);
      "its overlay works" = drv overlaid.artcraft-nix.gridcraft == drv packages.gridcraft;
      "its stable set has the flake's stable names, and none elsewhere" =
        builtins.attrNames plain.stable == builtins.attrNames self.legacyPackages.${system}.stable
        && (import ../default.nix { system = "x86_64-darwin"; }).stable == { };
    } "";

  # Other systems get a clear message, not a missing attribute.
  unsupported =
    let
      d = self.packages.aarch64-darwin.default;
    in
    conditions "unsupported" {
      "aarch64-darwin's default says Linux only" =
        d.name == "artcraft-nix-supports-Linux-only"
        && lib.hasInfix "supports Linux only" (lib.last d.args);
      "x86_64-darwin's too" =
        self.packages.x86_64-darwin.default.name == "artcraft-nix-supports-Linux-only";
      "plain `nix run` lists the apps and fails" =
        lib.hasInfix "artcraft-nix-apps"
          self.apps.${system}.default.program;
    } "";

  # The flake template, instantiated with this flake as its artcraft-nix
  # input (as `nix flake init` would leave it, with a stand-in for the
  # user's configuration.nix): it must evaluate to a whole NixOS system.
  template =
    let
      dir = ../templates/default;
      tpl = import (dir + "/flake.nix");
      # No nixpkgs.hostPlatform, as an older hardware-configuration.nix
      # leaves it: the template's fallback must cover it.
      configuration = {
        fileSystems."/" = {
          device = "/dev/sda1";
          fsType = "ext4";
        };
        boot.loader.grub.device = "nodev";
        system.stateVersion = "26.05";
      };
      withConfiguration = configuration: {
        lib = lib // {
          nixosSystem =
            args:
            import (path + "/nixos/lib/eval-config.nix") (
              {
                system = null;
              }
              // args
              // {
                modules = map (m: if m == dir + "/configuration.nix" then configuration else m) args.modules;
              }
            );
        };
      };
      hostWith =
        configuration:
        let
          outputs = tpl.outputs {
            self = outputs;
            nixpkgs = withConfiguration configuration;
            artcraft-nix = self;
          };
        in
        outputs.nixosConfigurations.nixos.config;
      host = hostWith configuration;
      # A hardware-configuration.nix as nixos-generate-config writes it now
      # (mkDefault), for another architecture: it wins, with no conflict.
      other = if system == "x86_64-linux" then "aarch64-linux" else "x86_64-linux";
      hostOther = hostWith (configuration // { nixpkgs.hostPlatform = lib.mkDefault other; });
    in
    conditions "template" {
      "the flake exports it, and it holds only flake.nix (init never overwrites a file)" =
        self.templates.default.path == dir && builtins.attrNames (builtins.readDir dir) == [ "flake.nix" ];
      "its inputs are this flake and nixos-unstable, not following each other" =
        tpl.inputs.artcraft-nix.url == "github:boltflake/artcraft-nix"
        && tpl.inputs.nixpkgs.url == "github:NixOS/nixpkgs/nixos-unstable"
        && !(tpl.inputs.artcraft-nix ? inputs);
      "it imports the user's configuration.nix and enables the apps" =
        host.programs.artcraft.enable && host.fileSystems."/".device == "/dev/sda1";
      "the whole system evaluates" = lib.hasSuffix ".drv" host.system.build.toplevel.drvPath;
      "a hardware configuration's own hostPlatform (mkDefault) wins over the template's fallback" =
        hostOther.nixpkgs.hostPlatform.system == other;
    } "";

  nix-format =
    runCommand "nix-format"
      {
        nativeBuildInputs = [ pkgs.nixfmt ];
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.fileFilter (f: f.hasExt "nix") ../.;
        };
      }
      ''
        find $src -name '*.nix' -print0 | xargs -0 nixfmt --check \
          || { echo "run \`nix fmt\` and commit the result"; exit 1; }
        touch $out
      '';

  init-scenarios =
    let
      # A sort that reads a little, prints part of a line and fails:
      # harsher than GNU sort, which prints nothing when a spill to TMPDIR
      # fails. And init with it first on its own PATH (where a scenario's
      # PATH can't reach).
      failingSort = pkgs.writeShellScriptBin "sort" ''
        head -c 10 > /dev/null || true
        printf partial
        exit 2
      '';
      initFailingSort = runCommand "init-failing-sort" { } ''
        mkdir -p $out/bin
        sed '0,/^export PATH="/s||export PATH="${failingSort}/bin:|' \
          ${packages.init}/bin/artcraft-nix-init > $out/bin/artcraft-nix-init
        chmod +x $out/bin/artcraft-nix-init
        grep -qF '${failingSort}/bin:' $out/bin/artcraft-nix-init
      '';
    in
    runCommand "init-scenarios"
      {
        nativeBuildInputs = [
          git
          pkgs.nix
        ];
      }
      ''
        set -u
        init=${packages.init}/bin/artcraft-nix-init
        tpl=${../templates/default/flake.nix}
        cat=${pkgs.coreutils}/bin/cat
        work=$(mktemp -d)
        mkdir -p $work/bin $work/extra $work/root/proc/sys/kernel $work/home $work/roothome
        # nix-channel lists $HOME's channels, as the real one does.
        cat > $work/bin/nix-channel <<SH
        #!${stdenv.shell}
        [ ! -e $work/channel-fails ] || { echo broken >&2; exit 1; }
        $cat "\$HOME/channels" 2> /dev/null || true
        SH
        cat > $work/bin/nixos-version <<SH
        #!${stdenv.shell}
        [ ! -e $work/version-fails ] || exit 1
        $cat $work/version
        SH
        cat > $work/bin/nix <<SH
        #!${stdenv.shell}
        [ ! -e $work/nix-fails ] || { echo "no config show here" >&2; exit 1; }
        case "\$*" in
          *"config show experimental-features") $cat $work/features ;;
          *) exit 1 ;;
        esac
        SH
        chmod +x $work/bin/*
        export HOME=$work/home GIT_CONFIG_NOSYSTEM=1 NIX_STATE_DIR=$work/nix-state
        git config --global user.email t@example.org
        git config --global user.name t
        # The build user owns everything here: it stands for the folder's
        # and repository's owner.
        self=$(id -u)

        # Scenario defaults: a release channel build, flakes on, this
        # user, configuration.nix in the default folder ($root/etc/nixos).
        etc=$work/root/etc/nixos
        reset() {
          chmod -R u+w $work/root/etc $work/top 2> /dev/null || true
          rm -rf $work/root/etc $work/top $work/link "$work/with space" $work/*-fails $work/extra/*
          mkdir -p $etc
          echo '{ }' > $etc/configuration.nix
          d=$etc
          rm -f $work/roothome/channels $work/home/channels
          echo '26.05.13936.ac588ef1c914 (Yarara)' > $work/version
          echo 'fetch-closure flakes nix-command' > $work/features
          echo my-box > $work/root/proc/sys/kernel/hostname
          uid=$self
          path="$work/extra:$work/bin:$PATH"
        }
        run() { # name, expected exit status, init's arguments (--dir unless default)
          local name=$1 want=$2 got=0 left
          shift 2
          [ "$d" = "$etc" ] || set -- --dir "$d" "$@"
          # (Its own TMPDIR, empty after every run, whatever the outcome.)
          mkdir -p $work/tmpdir
          ARTCRAFT_INIT_ROOT=$work/root ARTCRAFT_INIT_UID=$uid ARTCRAFT_INIT_ROOT_HOME=$work/roothome \
            TMPDIR=$work/tmpdir PATH="$path" $init "$@" > $work/out 2>&1 || got=$?
          echo "== $name (exit $got)"; cat $work/out
          [ "$got" = "$want" ] || { echo "$name: exit $got, expected $want"; exit 1; }
          left=$(find $work/tmpdir -mindepth 1)
          [ -z "$left" ] || { echo "$name: temporary files left: $left"; exit 1; }
        }
        has() { grep -qF -- "$1" $work/out || { echo "missing: $1"; exit 1; }; }
        hasLine() { grep -qxF -- "$1" $work/out || { echo "missing line: $1"; exit 1; }; }
        hasnt() { if grep -qF -- "$1" $work/out; then echo "unexpected: $1"; exit 1; fi; }
        wrote() { grep -qxF -- "$1" "$d/flake.nix" || { echo "flake.nix lacks: $1"; exit 1; }; }
        # Nothing written, and no temporary file left behind.
        clean() {
          [ ! -e "$d/flake.nix" ] || { echo "flake.nix written"; exit 1; }
          [ -z "$(find "$d/" -maxdepth 1 -name '.flake.nix.*')" ] || { echo "temporary file left"; exit 1; }
        }

        # The usual case: /etc/nixos, a release from nixos-version, this
        # host's name, so a plain rebuild.
        reset
        run release 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        wrote '      nixosConfigurations."my-box" = nixpkgs.lib.nixosSystem {'
        wrote '      # Build it with `sudo nixos-rebuild switch`.'
        wrote '    #   the running system'"'"'s version (26.05.13936.ac588ef1c914).'
        has 'nixpkgs: nixos-26.05, from the running system'"'"'s version (26.05.13936.ac588ef1c914)'
        hasLine '  sudo nixos-rebuild switch'
        has "To go back before rebuilding, delete $etc/flake.nix."
        hasnt "Flakes aren't"
        hasnt "configuration's name"
        [ "$(stat -c %a $etc/flake.nix)" = 644 ]
        [ -z "$(find $etc -name '.flake.nix.*')" ]
        # Nix parses it.
        nix-instantiate --parse $etc/flake.nix > /dev/null
        # This machine's system, for an older hardware-configuration.nix.
        wrote "          { nixpkgs.hostPlatform = nixpkgs.lib.mkOptionDefault \"$(uname -m)-linux\"; }"
        # Everything else is the template's: only its opening comment (5
        # lines), the comment over the nixpkgs line (8), that line, the
        # comment over the configuration (2) and its first line, and the
        # ARM hint are gone; the hostPlatform line too unless this machine
        # is x86_64, the template's.
        other=$([ "$(uname -m)" = x86_64 ] && echo 0 || echo 1)
        [ "$(grep -vxFf $etc/flake.nix $tpl | wc -l)" = $((18 + other)) ] || { echo "more of the template changed"; exit 1; }
        grep -vxFf $tpl $etc/flake.nix > $work/added
        [ "$(wc -l < $work/added)" = $((6 + other)) ] || { echo "more lines added than expected"; cat $work/added; exit 1; }

        # Not in git, with a file only root can read: as a flake, the folder
        # goes whole into the world-readable store; say so, and name it.
        reset
        mkdir -p $etc/secrets && echo key > $etc/secrets/wg0.key && chmod 600 $etc/secrets/wg0.key
        run private 0
        has "WARNING: as a flake, all of $etc is copied into the Nix store"
        has "  $etc/secrets/wg0.key"
        has "git -C $etc init"
        # sort failing (partial output, exit 2): every warning still comes
        # through, and the rebuild instructions.
        reset
        mkdir -p $etc/secrets && echo key > $etc/secrets/wg0.key && chmod 600 $etc/secrets/wg0.key
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/a.nix
        echo '{ imports = [ <nixos-hardware/x> ]; }' > $etc/b.nix
        realInit=$init
        init=${initFailingSort}/bin/artcraft-nix-init
        run sort-fails 0
        init=$realInit
        has "WARNING: as a flake, all of $etc is copied into the Nix store"
        hasLine "  $etc/secrets/wg0.key"
        has "These files use <…> paths"
        hasLine "  a.nix"
        hasLine "  b.nix"
        hasLine '  sudo nixos-rebuild switch'
        # A readable file in a folder only root can enter: private too.
        reset
        mkdir -p $etc/private && echo token > $etc/private/token && chmod 644 $etc/private/token && chmod 700 $etc/private
        run private-folder 0
        has "  $etc/private/ (and everything in it)"
        # --dir a link to the folder: the scan goes through it.
        reset
        mkdir -p $etc/secrets && echo key > $etc/secrets/wg0.key && chmod 600 $etc/secrets/wg0.key
        ln -s $etc $work/link
        d=$work/link
        run private-link 0
        has "  $work/link/secrets/wg0.key"
        # A folder above --dir that only root can enter: all of it is private.
        reset
        mkdir -p $work/root/etc/locked/nixos && echo '{ }' > $work/root/etc/locked/nixos/configuration.nix
        chmod 700 $work/root/etc/locked
        d=$work/root/etc/locked/nixos
        run private-parent 0
        has "  $d/ (and everything in it: other users can't enter $work/root/etc/locked)"
        chmod 755 $work/root/etc/locked
        # More scan errors than a pipe holds: init still finishes.
        reset
        # (Folders others can enter but this user can't read.)
        mkdir -p $etc/x && (cd $etc/x && mkdir $(seq -f d%g 2000) && chmod 311 d*)
        run scan-errors 0
        has "WARNING: couldn't check every file in $etc"
        has "Next,"
        (cd $etc/x && chmod 755 d*)
        # Everything readable already: nothing to warn about.
        reset
        run readable 0
        hasnt "WARNING: as a flake"

        # Run again: flake.nix exists, nothing changes.
        cp $etc/flake.nix $work/before
        run exists 0
        has 'exists already'
        cmp $work/before $etc/flake.nix

        # nixos-unstable, from a channel build's version.
        reset
        echo '26.11pre912345.0123456789ab (Zebra)' > $work/version
        run unstable 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";'

        # A flake build's or a git checkout's version doesn't tell: stop.
        for v in '26.05.20261113.f1e5c35 (Yarara)' '26.11pre-git (Zebra)' 'garbage'; do
          reset
          echo "$v" > $work/version
          run "version $v" 1
          has '--branch'
          clean
        done
        # nixos-version failing: stop, saying what was tried.
        reset
        touch $work/version-fails
        uid=0
        run version-fails 1
        has 'root has no nixos channel; nixos-version says nothing'
        clean

        # Root: the system's nixos channel wins over the version, read from
        # root's home even when sudo kept the caller's HOME.
        reset
        uid=0
        printf 'home-manager https://example.org/hm\nnixos https://nixos.org/channels/nixos-25.11-small/\n' > $work/roothome/channels
        echo 'nixos https://nixos.org/channels/nixos-unstable' > $work/home/channels
        run channel 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11-small";'
        has 'the system'"'"'s nixos channel (https://nixos.org/channels/nixos-25.11-small)'
        for c in https://channels.nixos.org/nixos-unstable https://nixos.org/channels/nixpkgs-unstable; do
          reset
          uid=0
          echo "nixos $c" > $work/roothome/channels
          run "channel $c" 0
          wrote "    nixpkgs.url = \"github:NixOS/nixpkgs/''${c##*/}\";"
        done
        # A channel that isn't one of NixOS's own: stop, don't guess;
        # suggest its name when that's a branch.
        reset
        uid=0
        echo "nixos https://example.org/my-nixpkgs" > $work/roothome/channels
        run other-channel 1
        has "your system's nixos channel is https://example.org/my-nixpkgs"
        has '--branch nixos-26.05.'
        clean
        reset
        uid=0
        echo "nixos https://mirror.example.org/nix-channels/nixos-25.11" > $work/roothome/channels
        run mirror-channel 1
        has '--branch nixos-25.11.'
        clean
        # nix-channel failing: the version instead.
        reset
        uid=0
        touch $work/channel-fails
        run channel-fails 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        # Not root: another user's channels aren't the system's.
        reset
        echo 'nixos https://nixos.org/channels/nixos-unstable' > $work/home/channels
        run user-channel 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'

        # --branch and --host: the command to build it names the host, in
        # the file and the output.
        reset
        run flags 0 --branch nixos-unstable --host other_box
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";'
        wrote '    # The branch given with --branch when init ran.'
        wrote '      nixosConfigurations."other_box" = nixpkgs.lib.nixosSystem {'
        wrote "      # Build it with \`sudo nixos-rebuild switch --flake $etc#other_box\`."
        has 'nixpkgs: nixos-unstable, from --branch.'
        hasLine "  sudo nixos-rebuild switch --flake $etc#other_box"
        hasnt "configuration's name"
        reset
        run bad-branch 1 --branch master
        clean
        reset
        run bad-host 1 --host 'a"b'
        clean

        # A dotted host name is kept (quoted); one that can't be a name
        # becomes `nixos`, said so; only then.
        reset
        echo 'my.box' > $work/root/proc/sys/kernel/hostname
        run dotted-host 0
        wrote '      nixosConfigurations."my.box" = nixpkgs.lib.nixosSystem {'
        hasLine '  sudo nixos-rebuild switch'
        nix-instantiate --parse $etc/flake.nix > /dev/null
        reset
        echo 'my box' > $work/root/proc/sys/kernel/hostname
        run bad-hostname 0
        wrote '      nixosConfigurations."nixos" = nixpkgs.lib.nixosSystem {'
        has 'Your host name, my box, can'"'"'t be'
        hasLine "  sudo nixos-rebuild switch --flake $etc#nixos"
        reset
        echo nixos > $work/root/proc/sys/kernel/hostname
        d=$work/top
        mkdir -p $d && echo '{ }' > $d/configuration.nix
        run host-nixos-elsewhere 0
        hasnt "configuration's name"

        # Printed commands are quoted for pasting.
        reset
        d="$work/with space"
        mkdir -p "$d" && echo '{ }' > "$d/configuration.nix"
        run spaces 0
        has "--flake $(printf '%q' "$d#my-box")"

        # A relative folder is printed absolute; one with # or ? is refused.
        reset
        mkdir -p $work/top/conf && echo '{ }' > $work/top/conf/configuration.nix
        (cd $work/top && run relative 0 --dir conf)
        hasLine "  sudo nixos-rebuild switch --flake $work/top/conf#my-box"
        # Not another conf found through CDPATH.
        rm $work/top/conf/flake.nix
        mkdir -p $work/cdpath/conf && echo '{ }' > $work/cdpath/conf/configuration.nix
        (cd $work/top && CDPATH=$work/cdpath run cdpath 0 --dir conf)
        hasLine "  sudo nixos-rebuild switch --flake $work/top/conf#my-box"
        [ ! -e $work/cdpath/conf/flake.nix ]
        rm -rf $work/cdpath
        reset
        d="$work/my#conf"
        mkdir -p "$d" && echo '{ }' > "$d/configuration.nix"
        run hash-in-dir 1
        has 'has a # or ? in it'
        clean
        rm -rf "$d"

        # --dry-run prints and writes nothing.
        reset
        run dry-run 0 --dry-run
        has '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        clean

        # Refusals: no configuration.nix; a folder it can't write to.
        reset
        rm $etc/configuration.nix
        run no-configuration 1
        has 'no configuration.nix'
        reset
        chmod a-w $etc
        run read-only 1
        has "can't write to"
        clean
        # Flakes off: written (nixos-rebuild turns them on itself), and
        # said; the check failing is said differently.
        reset
        echo 'nix-command' > $work/features
        run flakes-off 0
        has 'Flakes aren'"'"'t turned on'
        has 'nix.settings.experimental-features = [ "nix-command" "flakes" ];'
        reset
        touch $work/nix-fails
        run nix-fails 0
        has "Couldn't check whether flakes are turned on (nix said: no config show here)"
        # Channel paths in configuration.nix: a flake can't use them.
        reset
        echo '{ imports = [ <home-manager/nixos> ./hardware-configuration.nix ]; }' > $etc/configuration.nix
        printf '{\n  "%s" = 1;\n}\n' "\''${toString <nixpkgs>}" > $etc/other.nix
        echo '{ imports = [ <nixpkgs/nixos/modules/installer/scan/not-detected.nix> ]; }' > $etc/hardware-configuration.nix
        run channel-paths 0
        has 'These files use <…> paths'
        hasLine '  configuration.nix'
        hasLine '  hardware-configuration.nix'
        hasLine '  other.nix'
        # The same through a linked --dir.
        reset
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/configuration.nix
        ln -s $etc $work/link
        d=$work/link
        run channel-paths-linked-dir 0
        hasLine '  configuration.nix'
        reset
        # Text that only looks like one, in a string and a comment.
        printf '{\n  # press <Enter>\n  x = "<uuid>";\n  y = "(__findFile __nixPath \\"z\\")";\n  z = "(__findFile __nixPath ";\n  w = "x (__findFile __nixPath ''${"q"}";\n}\n' > $etc/configuration.nix
        run no-channel-paths 0
        hasnt '<…>'
        # A quote in the folder's name doesn't turn the scan around.
        reset
        d="$work/one\"q"
        mkdir -p "$d"
        echo '{ a = ./p; b = <nixpkgs>; }' > "$d/configuration.nix"
        echo '{ a = ./p; b = "(__findFile __nixPath "; c = ")"; }' > "$d/other.nix"
        run quote-in-folder 0
        hasLine '  configuration.nix'
        hasnt '  other.nix'
        rm -rf "$d"
        # A big file (about 1 MB) is scanned in seconds, not minutes.
        reset
        { echo '{ x = ['; for i in $(seq 60000); do echo "\"item $i {\""; done; echo ']; }'; } > $etc/big.nix
        start=$(date +%s)
        run big-file 0
        [ $(( $(date +%s) - start )) -lt 60 ] || { echo "the scan took a minute or more"; exit 1; }
        hasnt '<…>'
        # configuration.nix linked from outside the folder: said.
        reset
        mkdir -p $work/top
        mv $etc/configuration.nix $work/top/configuration.nix
        ln -s $work/top/configuration.nix $etc/configuration.nix
        run linked-configuration 0
        has "configuration.nix goes through an absolute link ($etc/configuration.nix -> $work/top/configuration.nix)"
        # Absolute, even to a file in the folder: the store copy can't follow
        # it.
        reset
        mkdir -p $etc/hosts
        mv $etc/configuration.nix $etc/hosts/box.nix
        ln -s $etc/hosts/box.nix $etc/configuration.nix
        run absolute-link-inside 0
        has "configuration.nix goes through an absolute link ($etc/configuration.nix -> $etc/hosts/box.nix)"
        # A chain: relative, then absolute.
        reset
        mkdir -p $etc/hosts
        mv $etc/configuration.nix $etc/hosts/box.nix
        ln -s $etc/hosts/box.nix $etc/current.nix
        ln -s current.nix $etc/configuration.nix
        run absolute-in-chain 0
        has "configuration.nix goes through an absolute link ($etc/current.nix -> $etc/hosts/box.nix)"
        # A link to a file in the folder that isn't named .nix: scanned.
        reset
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/box.conf
        rm $etc/configuration.nix
        ln -s box.conf $etc/configuration.nix
        run linked-not-nix 0
        has "  configuration.nix (that is, $etc/box.conf)"
        hasnt 'is a link to'
        # Relative, out of the folder (no repository).
        reset
        mkdir -p $work/root/etc/shared
        mv $etc/configuration.nix $work/root/etc/shared/configuration.nix
        ln -s ../shared/configuration.nix $etc/configuration.nix
        run relative-link-outside 0
        has "configuration.nix is a link to $work/root/etc/shared/configuration.nix, outside $etc"
        # --dir a folder whose name ends in a line break, beside one
        # without: refused, nothing written in either.
        reset
        nl="$work/root/etc/cfg"$'\n'
        mkdir -p "$nl" $work/root/etc/cfg
        echo '{ }' > $work/root/etc/cfg/configuration.nix
        echo '{ }' > "$nl/configuration.nix"
        d=$nl
        run newline-dir 1
        has "has a line break in a name, which init doesn't handle"
        [ ! -e "$nl/flake.nix" ] && [ ! -e $work/root/etc/cfg/flake.nix ] || { echo "flake.nix written"; exit 1; }
        # Reached through a link: refused too.
        ln -s "$nl" $work/link
        d=$work/link
        run newline-dir-link 1
        has "has a line break in a name"
        [ ! -e "$nl/flake.nix" ] && [ ! -e $work/root/etc/cfg/flake.nix ] || { echo "flake.nix written"; exit 1; }
        # A line break only in a part of the argument that .. undoes.
        rm $work/link
        d="$nl/../cfg"
        run newline-dir-arg 1
        has "has a line break in a name"
        [ ! -e $work/root/etc/cfg/flake.nix ] || { echo "flake.nix written"; exit 1; }
        # configuration.nix a link to a name ending in a line break, beside
        # one without: not followed, and said.
        reset
        echo '{ imports = [ <home-manager/nixos> ]; }' > "$etc/box.conf"$'\n'
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/box.conf
        rm $etc/configuration.nix
        ln -s "box.conf"$'\n' $etc/configuration.nix
        run newline-link 0
        has "whose target has a line"
        hasnt "(that is, $etc/box.conf"
        # A git work tree set elsewhere: its top folder isn't used. Run
        # through a link with a space in its name, git recording its calls.
        reset
        mkdir -p $work/top
        git -C $etc init -q
        git -C $etc config core.worktree $work/top
        echo other > $work/top/flake.nix
        ln -s $etc "$work/with space"
        d="$work/with space"
        printf '#!${stdenv.shell}\nprintf "%%s\\n" "$*" >> %s/git-calls\nexec ${pkgs.git}/bin/git "$@"\n' $work > $work/extra/git
        chmod +x $work/extra/git
        run worktree-elsewhere 0
        has "has a git repository whose work tree is elsewhere (core.worktree or"
        hasnt "Added flake.nix"
        # Only commands that look, the folder quoted as given, the real path
        # as what to expect; git add never run, nothing done there.
        hasLine "git -C $work/with\ space config --show-origin --get core.worktree."
        hasLine "Check that git -C $work/with\ space rev-parse --show-toplevel prints"
        has "$etc or a folder above it that's the repository's top, and only then"
        if grep -q '^add\b\|[[:space:]]add\b' $work/git-calls; then echo "git add was run"; exit 1; fi
        rm $work/git-calls $work/extra/git
        [ "$(cat $work/top/flake.nix)" = other ] || { echo "the other work tree's flake.nix changed"; exit 1; }
        staged=$(git -C $etc ls-files)
        [ -z "$staged" ] || { echo "something staged"; exit 1; }
        # Nested in a repository, GIT_WORK_TREE pointing elsewhere: no git
        # add; with it unset, the printed check gives the repository's top.
        reset
        mkdir -p $work/top/hosts/box $work/elsewhere
        echo '{ }' > $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        d=$work/top/hosts/box
        printf '#!${stdenv.shell}\nprintf "%%s\\n" "$*" >> %s/git-calls\nexec ${pkgs.git}/bin/git "$@"\n' $work > $work/extra/git
        chmod +x $work/extra/git
        GIT_WORK_TREE=$work/elsewhere run worktree-env 0
        has "has a git repository whose work tree is elsewhere"
        has "or a folder above it that's the repository's top"
        hasnt "Added flake.nix"
        hasLine "Check that git -C $d rev-parse --show-toplevel prints"
        if grep -q '^add\b\|[[:space:]]add\b' $work/git-calls; then echo "git add was run"; exit 1; fi
        rm $work/git-calls $work/extra/git
        [ ! -e $work/elsewhere/flake.nix ] || { echo "flake.nix put in the other work tree"; exit 1; }
        staged=$(git -C $work/top ls-files)
        [ -z "$staged" ] || { echo "something staged"; exit 1; }
        [ "$(git -C $d rev-parse --show-toplevel)" = $work/top ] || { echo "unset, the check doesn't give the repository's top"; exit 1; }
        rm -rf $work/elsewhere
        # A work tree that's a near-namesake: this folder's name and a line
        # break. Elsewhere too, and nothing done there.
        reset
        mkdir -p "$etc"$'\n'
        echo other > "$etc"$'\n'/flake.nix
        git -C $etc init -q
        git -C $etc config core.worktree "$etc"$'\n'
        run worktree-namesake 0
        has "has a git repository whose work tree is elsewhere"
        hasnt "Added flake.nix"
        [ "$(cat "$etc"$'\n'/flake.nix)" = other ] || { echo "the namesake's flake.nix changed"; exit 1; }
        rm -rf "$etc"$'\n'
        # A warning from git on stderr isn't part of the top folder.
        reset
        git -C $etc init -q
        printf '#!${stdenv.shell}\necho "warning: unable to access /x/.gitconfig" >&2\nexec ${pkgs.git}/bin/git "$@"\n' > $work/extra/git
        chmod +x $work/extra/git
        run git-warning 0
        has "Added flake.nix to the git repository in $etc."
        hasnt "work tree is elsewhere"
        # A repository whose top is /: a link inside the folder is fine.
        reset
        printf '#!${stdenv.shell}\ncase "$*" in *--show-toplevel*) echo /; exit 0 ;; esac\nexec ${pkgs.git}/bin/git "$@"\n' > $work/extra/git
        chmod +x $work/extra/git
        mkdir -p $work/root/etc/shared
        mv $etc/configuration.nix $work/root/etc/shared/box.nix
        ln -s ../shared/box.nix $etc/configuration.nix
        run root-repository 0
        # / is its top (owned by another user here, so no git add), and a
        # link out of the configuration folder stays inside the repository.
        has "is in a git repository (/), and the flake only sees files"
        hasnt "outside"
        rm $work/extra/git
        # Should git ever report its top through a link to this folder (it
        # resolves links itself today): it's this one, and flake.nix is
        # staged.
        reset
        ln -s $etc $work/link
        git -C $etc init -q
        printf '#!${stdenv.shell}\ncase "$*" in *--show-toplevel*) echo %s; exit 0 ;; esac\nexec ${pkgs.git}/bin/git "$@"\n' $work/link > $work/extra/git
        chmod +x $work/extra/git
        run worktree-alias 0
        has "Added flake.nix to the git repository"
        hasnt "work tree is elsewhere"
        staged=$(${pkgs.git}/bin/git -C $etc ls-files flake.nix)
        [ "$staged" = flake.nix ] || { echo "flake.nix not staged"; exit 1; }
        rm $work/extra/git
        # A link within the same repository is fine (the flake sees it).
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ imports = [ <home-manager/nixos> ]; }' > $work/top/shared/configuration.nix
        ln -s ../../shared/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add .
        d=$work/top/hosts/box
        run linked-in-repo 0
        hasnt 'link'
        has "  configuration.nix (that is, $work/top/shared/configuration.nix)"
        hasnt "git doesn't track yet"
        # The same, the linked file untracked: said, with the command.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s ../../shared/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        d=$work/top/hosts/box
        run linked-untracked 0
        has "configuration.nix links through files git doesn't track yet"
        hasLine "  git -C $work/top add $work/top/shared/configuration.nix"
        # Ignored: add -f. And a link in the chain git doesn't track.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/real.nix
        ln -s real.nix $work/top/shared/current.nix
        ln -s ../../shared/current.nix $work/top/hosts/box/configuration.nix
        echo shared/real.nix > $work/top/.gitignore
        git -C $work/top init -q
        git -C $work/top add .gitignore hosts
        d=$work/top/hosts/box
        run linked-chain-untracked 0
        hasLine "  git -C $work/top add $work/top/shared/current.nix"
        hasLine "  git -C $work/top add -f $work/top/shared/real.nix"
        # A linked folder on the way: untracked, it's listed; absolute, said.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s shared $work/top/sl
        ln -s ../../sl/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add hosts shared
        d=$work/top/hosts/box
        run linked-folder-untracked 0
        hasLine "  git -C $work/top add $work/top/sl"
        hasnt 'absolute link'
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s $work/top/shared $work/top/sl
        ln -s ../../sl/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add .
        d=$work/top/hosts/box
        run linked-folder-absolute 0
        has "configuration.nix goes through an absolute link ($work/top/sl -> $work/top/shared)"
        # Out of the folder and back: said.
        reset
        mkdir -p $work/root/etc/outside
        ln -s ../nixos $work/root/etc/outside/back
        mv $etc/configuration.nix $etc/real.nix
        ln -s ../outside/back/real.nix $etc/configuration.nix
        run out-and-back 0
        has "configuration.nix's links go through $work/root/etc, outside $etc"
        has "point the link at $etc/real.nix by a path that stays inside."
        # An ignored link in the folder, not named .nix: listed, add -f.
        reset
        git -C $etc init -q
        echo '{ }' > $etc/real.conf
        ln -s real.conf $etc/hop
        rm $etc/configuration.nix
        ln -s hop $etc/configuration.nix
        printf 'hop\nreal.conf\n' > $etc/.gitignore
        git -C $etc add configuration.nix .gitignore
        run ignored-hop 0
        hasLine "  git -C $etc add -f $etc/hop"
        hasLine "  git -C $etc add -f $etc/real.conf"
        # Untracked (not ignored) in the folder: listed once, with the rest.
        reset
        git -C $etc init -q
        mv $etc/configuration.nix $etc/real.nix
        ln -s real.nix $etc/configuration.nix
        run untracked-once 0
        [ "$(grep -c 'real.nix' $work/out)" = 1 ] || { echo "real.nix listed more than once"; exit 1; }
        hasnt "git doesn't track yet. Run:"

        # A git repository: flake.nix staged; untracked and ignored files
        # listed.
        reset
        git -C $etc init -q
        echo hardware-configuration.nix > $etc/.gitignore
        git -C $etc add configuration.nix .gitignore
        echo '{ }' > $etc/hardware-configuration.nix
        echo '{ }' > $etc/extra.nix
        run git 0
        [ "$(git -C $etc diff --cached --name-only)" = "$(printf '.gitignore\nconfiguration.nix\nflake.nix')" ]
        has '  extra.nix'
        has 'These .nix files are ignored:'
        has '  hardware-configuration.nix'
        has "git -C $etc add -f <file>"
        # The repository above the folder, reached through a link.
        reset
        mkdir -p $work/top/sub
        echo '{ }' > $work/top/sub/configuration.nix
        git -C $work/top init -q
        git -C $work/top add sub/configuration.nix
        ln -s $work/top/sub $work/link
        d=$work/link
        run nested-git 0
        has "Added flake.nix to the git repository in $work/top."
        [ "$(git -C $work/top diff --cached --name-only)" = "$(printf 'sub/configuration.nix\nsub/flake.nix')" ]
        # Root, in a repository someone else owns: not staged (it would
        # leave root's files in their .git); the owner is told what to run.
        reset
        uid=0
        git -C $etc init -q
        run others-repo 0
        has "As the repository's owner, run:"
        hasLine "  git -C $etc add flake.nix"
        [ -z "$(git -C $etc diff --cached --name-only)" ]
        # git add failing: its reason, and what to run.
        reset
        git -C $etc init -q
        echo flake.nix > $etc/.gitignore
        run git-fails 0
        has 'adding flake.nix failed:'
        has 'ignored by one of your .gitignore files'
        has "git -C $etc add flake.nix"
        # git refusing to look (say, safe.directory): its reason.
        reset
        # (The first call refuses; any later one would say something else.)
        printf '#!${stdenv.shell}\necho x >> %s/git-calls\nif [ "$(wc -l < %s/git-calls)" = 1 ]; then echo "fatal: detected dubious ownership in repository" >&2; else echo "fatal: not a git repository" >&2; fi\nexit 128\n' $work $work > $work/extra/git
        chmod +x $work/extra/git
        run git-refuses 0
        has "git couldn't check whether"
        has 'detected dubious ownership'
        [ "$(wc -l < $work/git-calls)" = 1 ] || { echo "git asked more than once"; exit 1; }
        rm $work/git-calls
        # No git, but a .git folder.
        reset
        mkdir $etc/.git
        path=$work/bin
        run no-git 0
        has "is a git repository, and the flake only sees files git tracks"

        touch $out
      '';

  # The scripts, tests and workflows, without the snapshot (only the stable
  # checks read it, so moving it changes no other check).
  sources = runCommand "artcraft-nix-sources" { } ''
    mkdir -p $out
    cp -r ${../shared} $out/shared
    cp -r ${../scripts} $out/scripts
    cp -r ${../tests} $out/tests
    cp -r ${../watcher} $out/watcher
    cp -r ${../keys} $out/keys
    cp ${../README.md} $out/README.md
    # The status page's demo, which its tests compare with its fixtures.
    mkdir $out/docs && cp ${../docs/status-demo.html} $out/docs/status-demo.html
    cp -r ${
      builtins.path {
        name = "versions";
        path = ../versions;
        filter = path: _: baseNameOf path != "stable";
      }
    } $out/versions
    mkdir $out/.github && cp -r ${../.github/workflows} $out/.github/workflows
    cp -r ${../.github/actions} $out/.github/actions
    cp ${../.github/zizmor.yml} $out/.github/zizmor.yml
    cp ${../.github/actionlint.yaml} $out/.github/actionlint.yaml
    cp ${../.github/dependabot.yml} $out/.github/dependabot.yml
    mkdir $out/lib && cp ${./checks.nix} $out/lib/checks.nix && cp ${./package-checks.nix} $out/lib/package-checks.nix
    cp ${../package.json} $out/package.json
    cp ${../tsconfig.json} $out/tsconfig.json
  '';

  # The TypeScript tests (node --test), offline, with GitHub, KV, the clock
  # and a signing key stubbed by fixtures; then the workflows and composite
  # actions, linted: actionlint (with shellcheck on run: scripts), zizmor
  # offline, and shellcheck on scripts/ci/*.sh.
  unit =
    runCommand "unit"
      {
        nativeBuildInputs = [
          nodejs_26
          git
          pkgs.gnupg
          pkgs.actionlint
          pkgs.zizmor
          pkgs.shellcheck
          pkgs.jq
        ];
      }
      ''
        cp -r ${sources}/. . && chmod -R u+w .
        export HOME=$(mktemp -d)
        node --test tests/*.test.ts
        zizmor() {
          command zizmor --offline --strict-collection --no-progress \
            --config .github/zizmor.yml "$@"
        }
        found=$(find .github/workflows -name '*.yml' -o -name '*.yaml')
        [ -n "$found" ] || { echo "no workflows found"; exit 1; }
        mapfile -t workflows <<< "$found"
        found=$(find .github/actions -name action.yml -o -name action.yaml)
        [ -n "$found" ] || { echo "no composite actions found"; exit 1; }
        mapfile -t actions <<< "$found"
        actionlint -config-file .github/actionlint.yaml "''${workflows[@]}"
        zizmor "''${workflows[@]}" "''${actions[@]}" .github/dependabot.yml
        found=$(find scripts/ci -name '*.sh')
        if [ -n "$found" ]; then
          mapfile -t shells <<< "$found"
          shellcheck "''${shells[@]}"
        fi
        touch $out
      '';

  # Node's type definitions, for the type check only (pinned npm tarballs;
  # nothing from npm runs). The same as t3code-nix's.
  typesNode = fetchurl {
    url = "https://registry.npmjs.org/@types/node/-/node-26.6.6.tgz";
    hash = "sha512-MzQj+8Kx3XI40OmUAE6Qoh58ZMNstNNMwn2nfd3qWsfe7nDNSqJNzes4njhz6AHwrSHOffSLwXU6yb474Q4aog==";
  };
  undiciTypes = fetchurl {
    url = "https://registry.npmjs.org/undici-types/-/undici-types-8.9.0.tgz";
    hash = "sha512-KTDyRTYX8sWmKXAikPHHSyc63CRPETMctyjKFupcC6OBLXT3xsN0e9aF7m+mIXutFWpUXuedtowG7iLOzp0kQg==";
  };
  typecheck = runCommand "typecheck" { nativeBuildInputs = [ typescript ]; } ''
    cp -r ${sources}/. . && chmod -R u+w .
    mkdir -p node_modules/@types/node node_modules/undici-types
    tar -xzf ${typesNode} -C node_modules/@types/node --strip-components=1
    tar -xzf ${undiciTypes} -C node_modules/undici-types --strip-components=1
    tsc -p .
    touch $out
  '';

  # Every pin matches shared/sources.ts, and every URL names its version
  # (scripts/check-pins.ts). Not the stable snapshot: no default check reads
  # it, so moving it changes none (publish relies on that); the stable
  # suites build its pins.
  pins = runCommand "pins" { nativeBuildInputs = [ nodejs_26 ]; } ''
    cp -r ${sources}/. . && chmod -R u+w .
    node scripts/check-pins.ts versions
    touch $out
  '';

  # An unavailable package still evaluates, and building it fails with the
  # marker's message and its issue (its builder, run here).
  unavailable-message =
    let
      versions = import ./versions.nix { inherit lib; };
      d = versions.unavailableDrv {
        pname = "figcraft-server";
        version = "0.18.1";
        inherit system;
        marker = {
          since = "2026-11-21T00:00:00Z";
          issue = 40;
          packages = [ "figcraft-server" ];
        };
      };
    in
    runCommand "unavailable-message" { } ''
      status=0
      msg=$(${lib.escapeShellArgs ([ "/bin/sh" ] ++ d.args)} 2>&1) || status=$?
      [ "$status" = 1 ] || { echo "exit $status, not 1"; exit 1; }
      [ "$msg" = ${lib.escapeShellArg "figcraft-server 0.18.1 is unavailable: upstream deleted its release files (since 2026-11-21T00:00:00Z). See https://github.com/boltflake/artcraft-nix/issues/40."} ] \
        || { echo "unexpected message: $msg"; exit 1; }
      ${lib.optionalString (
        !(d.meta.unavailable && d.passthru.unavailable.issue == 40)
      ) "echo 'meta or passthru is wrong'; exit 1"}
      touch $out
    '';

  # A smoke that fails still leaves its status and log (the smoke
  # derivations always succeed; a small check reads the status), so the test
  # job can upload them. Here with a program that exits at once.
  smoke-failure-artifacts =
    let
      failing = pkgs.writeShellScript "failing-app" "echo 'cannot start' >&2; exit 3";
      run = runCommand "smoke-failure-run" {
        nativeBuildInputs = with pkgs; [
          xvfb-run
          xdotool
          imagemagick
          dbus
          util-linux
          procps
        ];
        DBUS_SESSION_CONF = "${pkgs.dbus}/share/dbus-1/session.conf";
        PROG = failing;
        NAME = "failing";
        WM_CLASS = "none";
      } "source ${./smoke.sh}";
    in
    runCommand "smoke-failure-artifacts" { } ''
      [ "$(cat ${run}/status)" = 1 ] || { echo "a failing smoke's status isn't 1"; exit 1; }
      grep -q 'FAILED: ' ${run}/log || { echo "its log doesn't say why"; cat ${run}/log; exit 1; }
      grep -q 'cannot start' ${run}/app.log || { echo "the app's own output is missing"; exit 1; }
      [ ! -e ${run}/screenshot.png ] || { echo "a screenshot that can't exist"; exit 1; }
      echo "a failed smoke leaves status, log and the app's log"
      touch $out
    '';

  # The doctor's scenarios: fixture machines, from a clean NixOS to a
  # confused one (scripts in tests/doctor/).
  doctor-scenarios = pkgs.callPackage ./doctor-scenarios.nix { doctor = packages.doctor; };

  # The status page, built offline from fixtures.
  status-page = runCommand "status-page" { nativeBuildInputs = [ nodejs_26 ]; } ''
    cp -r ${sources}/. . && chmod -R u+w .
    node scripts/status-page.ts --fixtures tests/fixtures/status --out $TMPDIR/site
    for f in index.html status.json live.json badges/photocraft.json; do
      [ -s $TMPDIR/site/$f ] || { echo "the status page has no $f"; exit 1; }
    done
    grep -q 'PhotoCraft' $TMPDIR/site/index.html
    touch $out
  '';
in
{
  inherit
    default-build
    aggregate
    module-eval
    no-self-rev
    overlay
    no-flakes
    unsupported
    template
    init-scenarios
    unit
    typecheck
    pins
    doctor-scenarios
    status-page
    smoke-failure-artifacts
    unavailable-message
    ;
  # Branch CI only (scripts/ci/test.ts), as in t3code-nix.
  inherit nix-format;
}
