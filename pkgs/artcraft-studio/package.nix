# ArtCraft Studio: upstream's Linux tarball (a Tauri app on WebKitGTK),
# installed as shipped, with these changes for NixOS and nothing else (the
# as-shipped check holds it to this list):
#
#   1. The binary's ELF interpreter and RPATH are patched (autoPatchelfHook)
#      against nixpkgs' WebKitGTK 4.1, GTK 3, libsoup 3 and the rest.
#   2. bin/artcraft is a wrapper (makeWrapper's, with wrapGAppsHook3's GIO
#      modules, GSettings schemas, pixbuf loaders and GStreamer plugins,
#      which WebKit plays video and audio with; the program is
#      bin/.artcraft-wrapped) that
#      also unsets APPIMAGE and sets CRAFT_UPDATE_MANAGED_BY=Nix and
#      CRAFT_UPDATE_MANAGED_HINT, as every wrapper here does. Studio has no
#      updater; the wrapper is the same so no package is an exception.
#   3. Its licence files, which the archive doesn't carry, are installed
#      from the release's commit into share/licenses/artcraft-studio/.
#
# Studio's analytics (Google Analytics and Microsoft Clarity) are left as
# shipped. The module's hostFileBlockAnalytics option blocks their loaders
# in /etc/hosts, machine-wide (see the README).
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  wrapGAppsHook3,
  makeWrapper,
  webkitgtk_4_1,
  gtk3,
  libsoup_3,
  glib,
  cairo,
  gdk-pixbuf,
  dbus,
  glib-networking,
  gst_all_1,
  versions,
}:
let
  repo = "artcraft";
  pname = "artcraft-studio";
  pin = versions.load repo;
  marker = versions.unavailable pin pname;
  licenseFiles = lib.mapAttrsToList (path: l: {
    name = baseNameOf path;
    file = fetchurl {
      inherit (l) url hash;
      name = "${pname}-${pin.version}-${baseNameOf path}";
    };
  }) (pin.licenses or { });
in
if marker != null then
  versions.unavailableDrv {
    bins = [ "artcraft" ];
    inherit pname marker;
    inherit (pin) version;
    inherit (stdenv.hostPlatform) system;
  }
else
  stdenv.mkDerivation (
    {
      # Studio has no --version: it starts. With no display it logs its
      # platform info, version included, then stops at GTK's start; that
      # line is the version probe.
      doInstallCheck = true;
      installCheckPhase = ''
        runHook preInstallCheck
        export HOME=$(mktemp -d) TMPDIR=$(mktemp -d)
        output=$(timeout 60 env --chdir=/ --ignore-environment HOME="$HOME" TMPDIR="$TMPDIR" "$out/bin/artcraft" 2>&1) || true
        if ! grep -qF 'artcraft_version: "${pin.version}"' <<< "$output"; then
          echo "artcraft doesn't report ${pin.version}:" >&2; echo "$output" | tail -20 >&2; exit 1
        fi
        echo "artcraft reports ${pin.version}"
        runHook postInstallCheck
      '';
    }
    // {
      inherit pname;
      inherit (pin) version;

      src = fetchurl (versions.asset pin pname stdenv.hostPlatform.system);

      nativeBuildInputs = [
        autoPatchelfHook
        wrapGAppsHook3
        makeWrapper
      ];
      buildInputs = [
        webkitgtk_4_1
        gtk3
        libsoup_3
        glib
        cairo
        gdk-pixbuf
        dbus
        glib-networking
        # WebKit's media playback (the start page plays a video).
        gst_all_1.gstreamer
        gst_all_1.gst-plugins-base
        gst_all_1.gst-plugins-good
        gst_all_1.gst-plugins-bad
        gst_all_1.gst-libav
        (lib.getLib stdenv.cc.cc)
      ];

      dontConfigure = true;
      dontBuild = true;
      dontStrip = true;

      installPhase = ''
        runHook preInstall
        mkdir -p $out
        cp -r bin share $out/
        ${lib.concatMapStrings (
          l: "install -Dm644 ${l.file} $out/share/licenses/${pname}/${l.name}\n"
        ) licenseFiles}
        runHook postInstall
      '';

      # One shell wrapper (makeWrapper's, as every package here has) with
      # wrapGAppsHook3's settings, instead of its binary wrapper.
      dontWrapGApps = true;
      postFixup = ''
        wrapProgram $out/bin/artcraft "''${gappsWrapperArgs[@]}" ${lib.escapeShellArgs versions.wrapperArgs}
      '';

      passthru = {
        inherit pin;
        inherit repo;
        files = [
          "bin/artcraft"
          "bin/.artcraft-wrapped"
          "share/applications/ai.artcraft.app.desktop"
          "share/icons/hicolor/*/apps/artcraft.png"
          "share/metainfo/ai.artcraft.app.metainfo.xml"
          "share/licenses/artcraft-studio/*"
        ];
        bins = [ "artcraft" ];
      };

      meta = {
        description = "Create AI images and video";
        homepage = "https://getartcraft.com";
        changelog = "https://github.com/storytold/artcraft/releases/tag/${pin.tag}";
        license = [
          lib.licenses.mit
          lib.licenses.asl20
        ];
        sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
        platforms = versions.platforms pin pname;
        mainProgram = "artcraft";
      };
    }
  )
