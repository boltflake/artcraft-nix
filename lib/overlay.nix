# Which of this flake's packages the overlay puts at the top level of pkgs.
# Every package is under pkgs.artcraft-nix.<name>; these are also added at
# the top level, each only if the user's nixpkgs has no package of that
# name, or has the same program under it (`sameAsNixpkgs`). A nixpkgs that
# later gains a different program under one of these names keeps it.
#
# The names are written out, not derived from the packages, so the
# overlay's attribute names never depend on evaluating a package.
let
  names = import ./packages.nix;
in
{
  # Every app, Studio and the companions.
  candidates = names.all;
  # nixpkgs packages these from storytold's own repositories (checked
  # against the pinned nixpkgs on 2026-11-22, and by the overlay check:
  # nixpkgs' meta.homepage must be github.com/storytold/<repo>), so ours,
  # tested and current, may replace them.
  sameAsNixpkgs = [
    "cadcraft"
    "deckcraft"
    "filmcraft"
    "gridcraft"
    "lightcraft"
    "pdfcraft"
    "photocraft"
    "soundcraft"
    "vectorcraft"
    "wordcraft"
  ];
  # Only under pkgs.artcraft-nix.
  notTopLevel = names.tools;
}
