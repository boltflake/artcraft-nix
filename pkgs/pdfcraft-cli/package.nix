# pdfcraft-cli: PdfCraft's headless command-line tool, from the PdfCraft
# release (pdfcraft-cli-<version>-linux-<arch>.tar.gz), installed as shipped,
# with these changes for NixOS and nothing else (the as-shipped check holds
# it to this list):
#
#   1. The binary's ELF interpreter and RPATH are patched (autoPatchelfHook).
#   2. bin/pdfcraft-cli is a wrapper (the program is bin/.pdfcraft-cli-wrapped)
#      that unsets APPIMAGE and sets CRAFT_UPDATE_MANAGED_BY=Nix and
#      CRAFT_UPDATE_MANAGED_HINT, as every wrapper here does.
#   3. The archive is flat: its licence files go to
#      share/licenses/pdfcraft-cli/, and its README.md is left out.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  versions,
}:
let
  repo = "pdfcraft";
  pname = "pdfcraft-cli";
  pin = versions.load repo;
  marker = versions.unavailable pin pname;
in
if marker != null then
  versions.unavailableDrv {
    bins = [ "pdfcraft-cli" ];
    inherit pname marker;
    inherit (pin) version;
    inherit (stdenv.hostPlatform) system;
  }
else
  stdenv.mkDerivation (
    versions.installCheck [ "pdfcraft-cli" ]
    // {
      inherit pname;
      inherit (pin) version;

      src = fetchurl (versions.asset pin pname stdenv.hostPlatform.system);

      nativeBuildInputs = [
        autoPatchelfHook
        makeWrapper
      ];
      buildInputs = [ (lib.getLib stdenv.cc.cc) ];

      dontConfigure = true;
      dontBuild = true;
      dontStrip = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 -t $out/bin pdfcraft-cli
        install -Dm644 -t $out/share/licenses/${pname} LICENSE-APACHE LICENSE-MIT NOTICE OFL-*.txt
        runHook postInstall
      '';

      dontAutoPatchelf = true;
      postFixup = ''
        autoPatchelf $out
        wrapProgram $out/bin/pdfcraft-cli ${lib.escapeShellArgs versions.wrapperArgs}
      '';

      passthru = {
        inherit pin repo;
        files = [
          "bin/pdfcraft-cli"
          "bin/.pdfcraft-cli-wrapped"
          "share/licenses/pdfcraft-cli/*"
        ];
        bins = [ "pdfcraft-cli" ];
        dropped = [ "README.md" ];
      };

      meta = {
        description = "PdfCraft's command-line tool for reading, converting and editing PDFs";
        homepage = "https://getartcraft.com/apps/pdfcraft";
        changelog = "https://github.com/storytold/pdfcraft/releases/tag/${pin.tag}";
        license = [
          lib.licenses.mit
          lib.licenses.asl20
          lib.licenses.ofl
        ];
        sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
        platforms = versions.platforms pin pname;
        mainProgram = "pdfcraft-cli";
        # PdfCraft installs a pdfcraft-cli too, with the text recognition
        # models this one lacks: with both, PdfCraft's wins.
        priority = 6;
      };
    }
  )
