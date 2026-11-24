# The flake's package names and where each comes from, with no nixpkgs
# needed: for pkgs/default.nix, the module, the overlay and the checks.
let
  entries = import ../pkgs/apps.nix;
  appNames = builtins.attrNames entries.apps;
in
rec {
  inherit entries appNames;
  # The repository each package's pin comes from.
  repoOf =
    builtins.listToAttrs (
      map (n: {
        name = n;
        value = n;
      }) appNames
    )
    // {
      artcraft-studio = "artcraft";
      pdfcraft-cli = "pdfcraft";
      figcraft-server = "figcraft";
    };
  companions = [
    "pdfcraft-cli"
    "figcraft-server"
  ];
  # What `default` and the module's `enable` install: every desktop app and
  # Studio.
  desktop = appNames ++ [ "artcraft-studio" ];
  # Every package from a repository release.
  all = desktop ++ companions;
  # The tools, which come from no release.
  tools = [
    "doctor"
    "init"
  ];
}
