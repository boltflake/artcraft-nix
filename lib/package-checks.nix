# Every package's own checks (the default suite's per-package part), all in
# the Nix sandbox: no network, no /dev/dri, a private HOME, XDG folders and
# /tmp. For a package named n:
#
#   n-version   every binary's --version gives the pinned version
#   n-libs      no binary has an unresolved NEEDED library, and every
#               library the app dlopens resolves from its RPATH
#   n-files     the package has exactly the files its entry declares
#   n-licences  the package installs its licence files
#   n-smoke     the app gets ready under Xvfb with Mesa's software renderer
#               (desktop packages; n-smoke-run holds its log and screenshot)
#   n-appimage  every program in bin/ is a wrapper that unsets APPIMAGE
#   n-as-shipped  the archive's tree is in the package as shipped, and the
#               package's opening comment states every change
#   n-desktop   the desktop file validates and resolves within the package
#
# Unavailable packages have none: their checks are left out of the gate.
{
  lib,
  pkgs,
  runCommand,
  packages,
}:
let
  names = import ./packages.nix;
  inherit (names.entries) apps;
  inherit (pkgs) mesa;
  available = n: packages ? ${n} && !(packages.${n}.meta.unavailable or false);

  # The libraries each dlopen package provides, by soname (acceptance matrix).
  sonames = {
    wayland = [
      "libwayland-client.so.0"
      "libwayland-egl.so.1"
    ];
    libxkbcommon = [
      "libxkbcommon.so.0"
      "libxkbcommon-x11.so.0"
    ];
    libx11 = [
      "libX11.so.6"
      "libX11-xcb.so.1"
    ];
    libxcb = [ "libxcb.so.1" ];
    libxcursor = [ "libXcursor.so.1" ];
    libxi = [ "libXi.so.6" ];
    libxrender = [ "libXrender.so.1" ];
    libglvnd = [
      "libEGL.so.1"
      "libGL.so.1"
    ];
    vulkan-loader = [ "libvulkan.so.1" ];
    dbus = [ "libdbus-1.so.3" ];
    libva = [
      "libva.so.2"
      "libva-drm.so.2"
    ];
    fontconfig = [ "libfontconfig.so.1" ];
  };

  bins = p: p.passthru.bins;

  version =
    n: p:
    runCommand "${n}-version" { } (
      ''
        export HOME=$(mktemp -d)
      ''
      + (
        if n == "artcraft-studio" then
          # No --version: it logs its version, then stops at GTK's start
          # with no display (docs/acceptance-matrix.md).
          ''
            out1=$(timeout 60 env --chdir=/ --ignore-environment HOME="$HOME" ${p}/bin/artcraft 2>&1) || true
            grep -qF 'artcraft_version: "${p.version}"' <<< "$out1" || { echo "artcraft doesn't report ${p.version}"; echo "$out1" | tail; exit 1; }
          ''
        else
          lib.concatMapStrings (b: ''
            v=$(env --chdir=/ --ignore-environment HOME="$HOME" ${p}/bin/${b} --version 2>&1) || { echo "${b} --version failed: $v"; exit 1; }
            # The exact version, not one that contains it (1.2.3 in 11.2.30).
            grep -Eq '(^|[^0-9.])${lib.escapeRegex p.version}([^0-9.]|$)' <<< "$v" || { echo "${b} --version doesn't report ${p.version}: $v"; exit 1; }
            echo "${b}: $v"
          '') (bins p)
      )
      + "touch $out\n"
    );

  libs =
    n: p:
    let
      expected = lib.concatMap (l: sonames.${l}) (
        lib.optionals (apps ? ${n}) (names.entries.dlopen.common ++ apps.${n}.dlopen)
      );
    in
    runCommand "${n}-libs" { nativeBuildInputs = [ pkgs.patchelf ]; } ''
      for b in ${lib.concatMapStringsSep " " (b: "${p}/bin/.${b}-wrapped") (bins p)}; do
        deps=$(${lib.getBin pkgs.stdenv.cc.libc}/bin/ldd "$b" 2>&1) || { echo "$b: $deps"; exit 1; }
        if grep -q "not found" <<< "$deps"; then echo "$b:"; grep "not found" <<< "$deps"; exit 1; fi
        echo "$b: every NEEDED library resolves"
      done
      ${lib.optionalString (expected != [ ]) ''
        main=${p}/bin/.${p.meta.mainProgram}-wrapped
        IFS=: read -ra dirs <<< "$(patchelf --print-rpath "$main")"
        for so in ${lib.escapeShellArgs expected}; do
          found=
          for d in "''${dirs[@]}"; do [ -e "$d/$so" ] && { found=$d; break; }; done
          [ -n "$found" ] || { echo "$main: $so (dlopened) isn't in its RPATH"; exit 1; }
          echo "$so: $found"
        done
      ''}
      touch $out
    '';

  files =
    n: p:
    runCommand "${n}-files" { nativeBuildInputs = [ pkgs.python3 ]; } ''
      python3 ${./files.py} files ${p} ${builtins.toFile "${n}-files.json" (builtins.toJSON p.passthru.files)}
      touch $out
    '';

  # Where each package's licence files are, and what they must include.
  licenceFiles =
    n:
    if apps ? ${n} then
      {
        dir = "share/doc/${n}";
        fonts = apps.${n}.fonts;
      }
    else
      {
        dir = "share/licenses/${n}";
        fonts = n == "pdfcraft-cli";
      };
  licences =
    n: p:
    let
      l = licenceFiles n;
    in
    runCommand "${n}-licences" { } ''
      for f in LICENSE-MIT LICENSE-APACHE NOTICE; do
        [ -s ${p}/${l.dir}/$f ] || { echo "${n}: no ${l.dir}/$f"; exit 1; }
      done
      grep -q 'MIT License' ${p}/${l.dir}/LICENSE-MIT || { echo "${n}: LICENSE-MIT isn't the MIT licence"; exit 1; }
      grep -q 'Apache License' ${p}/${l.dir}/LICENSE-APACHE || { echo "${n}: LICENSE-APACHE isn't the Apache licence"; exit 1; }
      n_ofl=$(find ${p}/${l.dir} -name 'OFL-*' | wc -l)
      ${
        if l.fonts then
          ''[ "$n_ofl" -gt 0 ] || { echo "${n}: meta says OFL fonts, but there are no OFL-* files"; exit 1; }''
        else
          ''[ "$n_ofl" -eq 0 ] || { echo "${n}: $n_ofl OFL-* files, but meta doesn't list the OFL"; exit 1; }''
      }
      ${lib.optionalString (
        lib.elem lib.licenses.ofl p.meta.license != l.fonts
      ) ''echo "${n}: meta.license and the OFL files disagree"; exit 1''}
      echo "${n}: licences in ${l.dir} ($n_ofl OFL)"
      touch $out
    '';

  # Each wrapper, run with its program swapped for `env`: what the program
  # would get.
  appimage =
    n: p:
    runCommand "${n}-appimage" { } ''
      cd ${p}/bin
      for f in * .*; do
        [ "$f" = . ] || [ "$f" = .. ] && continue
        case $f in
          .*-wrapped)
            w=''${f#.}; w=''${w%-wrapped}
            [ -e "$w" ] && grep -qF "${p}/bin/$f" "$w" || { echo "$f is reachable from bin/ but no wrapper runs it"; exit 1; }
            continue ;;
        esac
        head -c 2 "$f" | grep -q '#!' || { echo "bin/$f isn't a wrapper"; exit 1; }
        grep -qF "${p}/bin/.$f-wrapped" "$f" || { echo "bin/$f doesn't run bin/.$f-wrapped"; exit 1; }
        printf '#!${pkgs.runtimeShell}\nexec ${pkgs.coreutils}/bin/env\n' > $TMPDIR/dump-env
        chmod +x $TMPDIR/dump-env
        sed "s|\"${p}/bin/.$f-wrapped\"|$TMPDIR/dump-env|" "$f" > $TMPDIR/probe
        chmod +x $TMPDIR/probe
        env=$(APPIMAGE=/tmp/Other.AppImage $TMPDIR/probe)
        if grep -q '^APPIMAGE=' <<< "$env"; then echo "bin/$f passes APPIMAGE on"; exit 1; fi
        grep -qx 'CRAFT_UPDATE_MANAGED_BY=Nix' <<< "$env" || { echo "bin/$f doesn't set CRAFT_UPDATE_MANAGED_BY=Nix"; exit 1; }
        grep -qx 'CRAFT_UPDATE_MANAGED_HINT=Update your Nix sources and rebuild to get the new version.' <<< "$env" \
          || { echo "bin/$f doesn't set CRAFT_UPDATE_MANAGED_HINT"; exit 1; }
        echo "bin/$f: unsets APPIMAGE, sets the managed-update hint"
      done
      touch $out
    '';

  desktop =
    n: p:
    runCommand "${n}-desktop"
      {
        nativeBuildInputs = [
          pkgs.desktop-file-utils
          pkgs.libxml2
        ];
      }
      ''
        shopt -s nullglob
        files=(${p}/share/applications/*.desktop)
        [ ''${#files[@]} -eq 1 ] || { echo "${n}: ''${#files[@]} desktop files"; exit 1; }
        d=''${files[0]}
        desktop-file-validate "$d"
        key() { sed -n "s/^$1=//p" "$d" | head -1; }
        exec=$(key Exec); exec=''${exec%% *}
        [ -x "${p}/bin/$exec" ] || { echo "Exec=$exec isn't in the package's bin/"; exit 1; }
        try=$(key TryExec)
        [ -z "$try" ] || [ -x "${p}/bin/$try" ] || { echo "TryExec=$try isn't in the package's bin/"; exit 1; }
        icon=$(key Icon)
        icons=(${p}/share/icons/hicolor/*/apps/"$icon".png ${p}/share/icons/hicolor/*/apps/"$icon".svg)
        [ ''${#icons[@]} -gt 0 ] || { echo "Icon=$icon isn't in the package"; exit 1; }
        for x in ${p}/share/mime/packages/*.xml ${p}/share/metainfo/*.xml; do
          xmllint --noout "$x" || { echo "$x doesn't parse"; exit 1; }
        done
        for t in ${p}/share/thumbnailers/*.thumbnailer; do
          te=$(sed -n 's/^TryExec=//p' "$t")
          [ -x "${p}/bin/$te" ] || { echo "$t: TryExec=$te isn't in the package's bin/"; exit 1; }
        done
        echo "${n}: Exec=$exec, Icon=$icon (''${#icons[@]} sizes)"
        touch $out
      '';

  # The smokes. Mesa is set explicitly: users' drivers are in
  # /run/opengl-driver, the sandbox has none. LD_LIBRARY_PATH and
  # __GLX_VENDOR_LIBRARY_NAME are for the test only: glvnd finds Mesa's GLX
  # library through them here, and through /run/opengl-driver on NixOS.
  vulkanEnv = {
    VK_ICD_FILENAMES = "${mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json";
  };
  mesaGl = {
    LIBGL_DRIVERS_PATH = "${mesa}/lib/dri";
    __EGL_VENDOR_LIBRARY_DIRS = "${mesa}/share/glvnd/egl_vendor.d";
    LIBGL_ALWAYS_SOFTWARE = "1";
  };
  # Both backends, as users have them: what the window smokes run with.
  # (LD_LIBRARY_PATH would put Mesa's libraries before WebKit's, which then
  # paints nothing.)
  bothEnv = vulkanEnv // mesaGl;
  # For GLX through glvnd, which finds Mesa's library only this way here.
  glEnv = mesaGl // {
    LD_LIBRARY_PATH = "${mesa}/lib";
    __GLX_VENDOR_LIBRARY_NAME = "mesa";
  };
  # Only one backend's driver, so the forced renderer is the one that drew.
  vulkanOnly = vulkanEnv // {
    __EGL_VENDOR_LIBRARY_DIRS = "/var/empty";
    LIBGL_DRIVERS_PATH = "/var/empty";
    VK_LOADER_DEBUG = "driver";
  };
  glOnly = glEnv // {
    VK_ICD_FILENAMES = "/var/empty/none.json";
    # The dynamic linker names every library loaded: Mesa's gallium
    # driver is the evidence that GL drew.
    LD_DEBUG = "libs";
  };

  smokeRun =
    name: env:
    runCommand name (
      {
        nativeBuildInputs = with pkgs; [
          xvfb-run
          xdotool
          imagemagick
          dbus
          util-linux
          procps
        ];
        DBUS_SESSION_CONF = "${pkgs.dbus}/share/dbus-1/session.conf";
      }
      // env
    ) "source ${./smoke.sh}";
  smokeCheck =
    name: run:
    runCommand name { passthru.run = run; } ''
      [ -f ${run}/status ] && [ -f ${run}/log ] || { echo "${name}: the smoke left no result"; exit 1; }
      cat ${run}/log
      [ "$(cat ${run}/status)" = 0 ] || { echo "--- the app's log:"; tail -40 ${run}/app.log 2>/dev/null; exit 1; }
      touch $out
    '';

  smokes =
    n: p:
    let
      e = apps.${n} or null;
      base = {
        PROG = "${p}/bin/${p.meta.mainProgram}";
        NAME = n;
      };
      window =
        if n == "artcraft-studio" then
          base
          // bothEnv
          // {
            WM_CLASS = "artcraft";
            TITLE = "ArtCraft";
            READY_LOG = "Sizing and positioning window...";
            # Its start page plays a video and decodes audio: WebKit's
            # GStreamer must find its elements.
            FAIL_LOG = "GStreamer element .* not found|GStreamer-CRITICAL";
            # With GStreamer's autodetect plugin (WebKit's automatic audio
            # output), Studio's page stays blank in this sandbox, though it
            # draws and plays on a real desktop (checked by hand, with and
            # without network and sound). The window must still map, the
            # log must show no missing GStreamer element, and Studio must
            # stay up; the screenshot is kept for review.
            BLANK_OK = "Studio's page is blank in the build sandbox with GStreamer's autodetect plugin, not on a desktop";
            # WebKit takes a while to paint on llvmpipe.
            SETTLE = "20";
          }
        else
          base
          // bothEnv
          // {
            WM_CLASS = e.smoke.wmClass;
            SETTLE = "5";
          };
      runs = {
        "${n}-smoke" = smokeRun "${n}-smoke-run" window;
      }
      // lib.optionalAttrs (e != null && e.smoke.screenshot or false) {
        "${n}-smoke-vulkan" = smokeRun "${n}-smoke-vulkan-run" (
          base
          // vulkanOnly
          // {
            SCREENSHOT_RENDERER = "wgpu";
            RENDERER_EVIDENCE = "Found ICD manifest file ${vulkanEnv.VK_ICD_FILENAMES}";
          }
        );
        "${n}-smoke-gl" = smokeRun "${n}-smoke-gl-run" (
          base
          // glOnly
          // {
            SCREENSHOT_RENDERER = "gl";
            RENDERER_EVIDENCE = "libgallium";
          }
        );
      };
    in
    lib.mapAttrs smokeCheck runs // lib.mapAttrs' (k: v: lib.nameValuePair "${k}-run" v) runs;

  # The companions do one real job each.
  companionChecks = {
    # Reads text from a fixture PDF and renders its page.
    pdfcraft-cli =
      p:
      runCommand "pdfcraft-cli-job" { nativeBuildInputs = [ pkgs.file ]; } ''
        export HOME=$(mktemp -d)
        text=$(${p}/bin/pdfcraft-cli text ${../tests/fixtures/hello.pdf})
        [[ "$text" == *"Hello ArtCraft"* ]] || { echo "pdfcraft-cli text gave: $text"; exit 1; }
        ${p}/bin/pdfcraft-cli render ${../tests/fixtures/hello.pdf} --page 1 --out page.png
        file page.png | grep -q 'PNG image data' || { echo "pdfcraft-cli render wrote no PNG"; exit 1; }
        echo "pdfcraft-cli: read the fixture's text and rendered its page"
        touch $out
      '';
    # Starts on sandbox loopback with a temporary data directory and
    # answers its health request.
    figcraft-server =
      p:
      runCommand "figcraft-server-job" { nativeBuildInputs = [ pkgs.curl ]; } ''
        export HOME=$(mktemp -d)
        port=47911
        ${p}/bin/figcraft-server --listen 127.0.0.1:$port --data $TMPDIR/data > server.log 2>&1 &
        pid=$!
        ok=
        for _ in $(seq 1 100); do
          if body=$(curl -fsS --max-time 2 http://127.0.0.1:$port/healthz 2>/dev/null); then ok=1; break; fi
          kill -0 $pid 2>/dev/null || break
          sleep 0.1
        done
        kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
        [ -n "$ok" ] || { echo "figcraft-server didn't answer /healthz"; cat server.log; exit 1; }
        [ "$body" = ok ] || { echo "/healthz said: $body"; exit 1; }
        [ -d $TMPDIR/data ] || { echo "figcraft-server didn't make its data directory"; exit 1; }
        echo "figcraft-server: answered /healthz with ok"
        touch $out
      '';
  };

  # Each package's opening comment states every change made for NixOS, and
  # the package holds to it: the archive's tree is in the package as
  # shipped (binaries patched, in bin/ as .<name>-wrapped behind a wrapper;
  # every other file byte for byte), apart from the files it says it leaves
  # out; the comment names the wrapper's three settings and each file left
  # out.
  asShipped =
    n: p:
    let
      sourceFile = {
        artcraft-studio = ../pkgs/artcraft-studio/package.nix;
        pdfcraft-cli = ../pkgs/pdfcraft-cli/package.nix;
        figcraft-server = ../pkgs/figcraft-server/package.nix;
      };
      comment =
        n:
        let
          lines = lib.splitString "\n" (builtins.readFile (sourceFile.${n} or ../pkgs/craft-app.nix));
          end = lib.lists.findFirstIndex (l: !lib.hasPrefix "#" l) (builtins.length lines) lines;
        in
        lib.concatStringsSep "\n" (lib.take end lines);
      one =
        let
          c = comment n;
          dropped = p.passthru.dropped or [ ];
          isFlat = builtins.elem n names.companions;
          mentions = [
            "APPIMAGE"
            "CRAFT_UPDATE_MANAGED_BY"
            "CRAFT_UPDATE_MANAGED_HINT"
            "autoPatchelfHook"
          ]
          ++ lib.optionals (n != "artcraft-studio" && !isFlat) [ "dropped" ];
          missing = builtins.filter (m: !lib.hasInfix m c) (mentions ++ lib.optionals isFlat dropped);
        in
        ''
          echo "== ${n}"
          ${lib.optionalString (
            missing != [ ]
          ) ''echo "${n}: its opening comment doesn't mention: ${toString missing}"; exit 1''}
          rm -rf a && mkdir a && tar -xzf ${p.src} -C a --strip-components=1
          k=0
          while IFS= read -r -d "" f; do
            rel=''${f#a/}
            case " ${toString dropped} " in *" $rel "*) [ ! -e "${p}/$rel" ] || { echo "${n}: $rel is said to be left out, but it's there"; exit 1; }; continue ;; esac
            ${
              if isFlat then
                ''
                  case $rel in
                    ${n}) o=${p}/bin/.${n}-wrapped ;;
                    LICENSE-*|NOTICE|OFL-*|ATTRIBUTION.md|licenses/*) o=${p}/share/licenses/${n}/$rel ;;
                    *) echo "${n}: its archive's $rel isn't in the package or said to be left out"; exit 1 ;;
                  esac
                ''
              else
                ''
                  case $rel in
                    bin/*) o=${p}/bin/.''${rel#bin/}-wrapped ;;
                    share/*) o=${p}/$rel ;;
                    *) echo "${n}: its archive's $rel isn't in the package or said to be left out"; exit 1 ;;
                  esac
                ''
            }
            [ -e "$o" ] || { echo "${n}: its archive's $rel is missing (expected $o)"; exit 1; }
            if file -b "$f" | grep -q '^ELF'; then
              file -b "$o" | grep -q '^ELF' || { echo "${n}: $o isn't the archive's program"; exit 1; }
            else
              cmp "$f" "$o" || { echo "${n}: $rel differs from its archive's"; exit 1; }
            fi
            k=$((k + 1))
          done < <(find a -type f -print0)
          [ "$k" -gt 0 ] || { echo "${n}: nothing compared"; exit 1; }
          echo "${n}: $k files as shipped"
        '';
    in
    runCommand "${n}-as-shipped" { nativeBuildInputs = [ pkgs.file ]; } (one + "touch $out\n");

  forPackage =
    n:
    let
      p = packages.${n};
      desktopPkg = !builtins.elem n names.companions;
    in
    {
      "${n}-version" = version n p;
      "${n}-libs" = libs n p;
      "${n}-files" = files n p;
      "${n}-licences" = licences n p;
      "${n}-appimage" = appimage n p;
      "${n}-as-shipped" = asShipped n p;
    }
    // lib.optionalAttrs (companionChecks ? ${n}) { "${n}-job" = companionChecks.${n} p; }
    // lib.optionalAttrs desktopPkg (
      {
        "${n}-desktop" = desktop n p;
      }
      // smokes n p
    );
in
lib.foldl' (acc: n: acc // forPackage n) { } (builtins.filter available names.all)
