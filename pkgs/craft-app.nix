# One builder for the 17 Craft Apps, driven by each repository's pin
# (versions/<repo>.json) and the app's entry in pkgs/apps.nix. The package is
# upstream's Linux tarball, installed as shipped, with these changes for
# NixOS and nothing else (the as-shipped check holds it to this list):
#
#   1. The binaries' ELF interpreter and RPATH are patched (autoPatchelfHook)
#      against nixpkgs' glibc, libgcc and alsa-lib, and the libraries they
#      dlopen (display, GL and Vulkan, D-Bus; apps.nix) plus the NixOS driver
#      directory are added to the RPATH.
#   2. Each program in bin/ is a wrapper (makeWrapper's wrapProgram; the
#      program itself is bin/.<name>-wrapped, so it still finds its data at
#      <binary>/../share) that unsets APPIMAGE and sets
#      CRAFT_UPDATE_MANAGED_BY=Nix and CRAFT_UPDATE_MANAGED_HINT. APPIMAGE,
#      inherited from a program running as an AppImage, would make the
#      updater take that AppImage for its own (craft-libs self_update.rs);
#      the other two ask the update prompt to say how Nix updates it
#      (storytold/craft-libs#2975; versions without it ignore them).
#   3. Archive files outside bin/ and share/ (the entry's `dropped`, such as
#      FilmCraft's install.sh and AniCraft's anicraft-portable) are left out.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  alsa-lib,
  addDriverRunpath,
  pkgs,
  versions,
  name,
  entry,
  dlopenCommon,
}:
let
  pin = versions.load name;
  marker = versions.unavailable pin name;
  # Their library outputs (dbus and libva keep theirs apart from `out`).
  runtimeLibs = map (n: lib.getLib pkgs.${n}) (dlopenCommon ++ entry.dlopen);
  licenses = [
    lib.licenses.mit
    lib.licenses.asl20
  ]
  ++ lib.optional entry.fonts lib.licenses.ofl;
  meta = {
    description = entry.summary;
    homepage = "https://getartcraft.com/apps/${name}";
    changelog = "https://github.com/storytold/${name}/releases/tag/${pin.tag}";
    license = licenses;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = versions.platforms pin name;
    mainProgram = name;
  };
in
if marker != null then
  versions.unavailableDrv {
    inherit (entry) bins;
    pname = name;
    inherit (pin) version;
    inherit marker;
    inherit (stdenv.hostPlatform) system;
  }
else
  stdenv.mkDerivation (
    versions.installCheck entry.bins
    // {
      pname = name;
      inherit (pin) version;

      src = fetchurl (versions.asset pin name stdenv.hostPlatform.system);

      nativeBuildInputs = [
        autoPatchelfHook
        makeWrapper
      ];
      buildInputs = [
        alsa-lib
        (lib.getLib stdenv.cc.cc)
      ];
      # dlopened, so autoPatchelf adds them to the RPATH of every binary.
      runtimeDependencies = runtimeLibs;

      dontConfigure = true;
      dontBuild = true;
      # As shipped: nothing stripped, manual pages left uncompressed.
      dontStrip = true;
      dontGzipMan = true;

      installPhase = ''
        runHook preInstall
        mkdir -p $out
        cp -r bin share $out/
        runHook postInstall
      '';

      # Patched here, so the driver directory and the wrappers come after it.
      dontAutoPatchelf = true;
      postFixup = ''
        autoPatchelf $out
        for b in ${lib.escapeShellArgs entry.bins}; do
          # GPU drivers that aren't in nixpkgs (NVIDIA's CUDA and NVENC
          # libraries, which FilmCraft can use) are found where NixOS puts
          # them.
          patchelf --add-rpath ${addDriverRunpath.driverLink}/lib $out/bin/$b
          wrapProgram $out/bin/$b ${lib.escapeShellArgs versions.wrapperArgs}
        done
      '';

      passthru = {
        inherit pin entry;
        repo = name;
        inherit (entry) files bins dropped;
        dlopen = runtimeLibs;
      };

      inherit meta;
    }
  )
