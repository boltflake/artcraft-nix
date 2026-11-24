# A NixOS system with the ArtCraft apps, from artcraft-nix. It imports your
# configuration.nix. Build it with
#   sudo nixos-rebuild switch --flake /etc/nixos#nixos
# which works whatever your host name is. Optional: rename `nixos` below to
# your host name (`hostname`), and a plain `sudo nixos-rebuild switch` works.
{
  inputs = {
    # Check this line. It says nixos-unstable. If `sudo nix-channel --list`
    # shows a stable release, for example nixos-26.05, change it to
    # nixos-26.05, so your system stays on the release it's on now. If it
    # shows no `nixos` channel, find out which release your system follows
    # before you rebuild, because left as it is this line moves it to
    # unstable. `nix-instantiate --find-file nixpkgs` shows where <nixpkgs>
    # comes from now; trace that to its channel or revision, and use that
    # branch.
    # (This flake's packages bring their own nixpkgs either way.)
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    artcraft-nix.url = "github:boltflake/artcraft-nix";
  };

  outputs =
    { nixpkgs, artcraft-nix, ... }:
    {
      # `nixos` is NixOS's default host name: `--flake /etc/nixos#nixos`
      # builds it whatever yours is.
      nixosConfigurations.nixos = nixpkgs.lib.nixosSystem {
        modules = [
          ./configuration.nix
          artcraft-nix.nixosModules.default
          # Your machine's system, for a hardware-configuration.nix written
          # before NixOS set it there (a newer one's setting wins).
          # On an ARM machine, make it "aarch64-linux".
          { nixpkgs.hostPlatform = nixpkgs.lib.mkOptionDefault "x86_64-linux"; }
          {
            programs.artcraft = {
              enable = true; # every ArtCraft desktop app, Studio, and `artcraft-nix doctor`

              # Optional: uncomment what you need. All the options are under
              # "The NixOS module" in artcraft-nix's README.
              # apps = [ "photocraft" "pdfcraft" ];   # install only these
              # excludeApps = [ "artcraft-studio" ];  # or leave some out
              # nixpkgs = "stable";                   # NixOS stable's libraries
              # hostFileBlockAnalytics = true;        # block Studio's analytics loaders in /etc/hosts, for the whole machine
            };
          }
        ];
      };
    };
}
