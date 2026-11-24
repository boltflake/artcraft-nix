# figcraft-server: FigCraft's headless collaboration server, from the
# FigCraft release (figcraft-server-<version>-linux-<arch>.tar.gz), installed
# as shipped, with these changes for NixOS and nothing else (the as-shipped
# check holds it to this list):
#
#   1. The binary's ELF interpreter and RPATH are patched (autoPatchelfHook).
#   2. bin/figcraft-server is a wrapper (the program is
#      bin/.figcraft-server-wrapped) that unsets APPIMAGE and sets
#      CRAFT_UPDATE_MANAGED_BY=Nix and CRAFT_UPDATE_MANAGED_HINT, as every
#      wrapper here does.
#   3. The archive is flat: its licence files go to
#      share/licenses/figcraft-server/. Its deployment files for other
#      systems (install.sh, figcraft-server.service, figcraft-backup.service,
#      figcraft-backup.timer, Caddyfile, nginx.conf) and server.md are left
#      out; there is no NixOS service for it yet.
#
# It binds 127.0.0.1:47900 by default and keeps its data in ./figcraft-data
# under the working directory unless given --data.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  versions,
}:
let
  repo = "figcraft";
  pname = "figcraft-server";
  pin = versions.load repo;
  marker = versions.unavailable pin pname;
in
if marker != null then
  versions.unavailableDrv {
    bins = [ "figcraft-server" ];
    inherit pname marker;
    inherit (pin) version;
    inherit (stdenv.hostPlatform) system;
  }
else
  stdenv.mkDerivation (
    versions.installCheck [ "figcraft-server" ]
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
        install -Dm755 -t $out/bin figcraft-server
        install -Dm644 -t $out/share/licenses/${pname} LICENSE-APACHE LICENSE-MIT NOTICE
        runHook postInstall
      '';

      dontAutoPatchelf = true;
      postFixup = ''
        autoPatchelf $out
        wrapProgram $out/bin/figcraft-server ${lib.escapeShellArgs versions.wrapperArgs}
      '';

      passthru = {
        inherit pin repo;
        files = [
          "bin/figcraft-server"
          "bin/.figcraft-server-wrapped"
          "share/licenses/figcraft-server/*"
        ];
        bins = [ "figcraft-server" ];
        dropped = [
          "Caddyfile"
          "figcraft-backup.service"
          "figcraft-backup.timer"
          "figcraft-server.service"
          "install.sh"
          "nginx.conf"
          "server.md"
        ];
      };

      meta = {
        description = "FigCraft's collaboration server: keeps files for a team and serves their live sessions";
        homepage = "https://getartcraft.com/apps/figcraft";
        changelog = "https://github.com/storytold/figcraft/releases/tag/${pin.tag}";
        license = [
          lib.licenses.mit
          lib.licenses.asl20
        ];
        sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
        platforms = versions.platforms pin pname;
        mainProgram = "figcraft-server";
      };
    }
  )
