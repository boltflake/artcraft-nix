# `artcraft-nix-init` (`nix run github:boltflake/artcraft-nix#init`): writes
# /etc/nixos/flake.nix from the flake template for a NixOS system that
# isn't a flake yet, with its nixpkgs branch and host name filled in
# (init.sh, as in t3code-nix). It doesn't depend on any app: `nix run
# …#init` doesn't build or fetch one.
{
  lib,
  writeShellApplication,
  coreutils,
  findutils,
  gnugrep,
  gnused,
  gawk,
}:
writeShellApplication {
  name = "artcraft-nix-init";
  runtimeInputs = [
    coreutils
    findutils
    gnugrep
    gnused
    gawk
  ];
  # nix, nix-channel, nixos-version and git are the system's own.
  inheritPath = true;
  text =
    builtins.replaceStrings
      [ "template=@template@" ]
      [
        "template=${../../templates/default/flake.nix}"
      ]
      (builtins.readFile ./init.sh);
  meta = {
    description = "Makes a NixOS system that isn't a flake yet into one with the ArtCraft apps (artcraft-nix)";
    mainProgram = "artcraft-nix-init";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
