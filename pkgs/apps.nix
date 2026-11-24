# The per-app entries pkgs/craft-app.nix builds the 17 Craft Apps from, one
# per repository. docs/acceptance-matrix.md has the evidence for each field,
# and the checks hold the packages to them:
#
#   bins:     the programs in bin/, each probed with --version (<app>-version)
#   files:    every file the package provides, as patterns (`*` within one
#             path component, a last `**` for a whole folder); <app>-files proves the package has exactly
#             these, and `aggregate` that no two apps in `default` overlap
#   dlopen:   the libraries the binaries dlopen, from nixpkgs, beyond the
#             common set (`dlopen.common`); they go in the RPATH
#   smoke:    what <app>-smoke counts as ready: an X window with this WM
#             class maps and stays up, and the screen isn't blank. With
#             `screenshot`, the app also writes its own PNG of its sample
#             (--screenshot) and exits 0, once per forced renderer.
#   data:     data folders under share/ the app finds next to its binary
#   dropped:  archive files left out (stated in pkgs/craft-app.nix)
#   fonts:    the archive bundles fonts under the OFL (share/doc/<app>/OFL-*)
#   summary:  the metainfo's summary
let
  # What every Craft App's archive has, for app `n`.
  standard =
    n: bins:
    map (b: "bin/${b}") bins
    ++ map (b: "bin/.${b}-wrapped") bins
    ++ [
      "share/applications/ai.storyteller.${n}.desktop"
      "share/icons/hicolor/*/apps/ai.storyteller.${n}.*"
      "share/metainfo/ai.storyteller.${n}.metainfo.xml"
      "share/doc/${n}/**"
    ];
  mime = n: [ "share/mime/packages/ai.storyteller.${n}.xml" ];
  # The CLI's completions and manual pages.
  completions = n: [
    "share/bash-completion/completions/${n}-cli"
    "share/fish/vendor_completions.d/${n}-cli.fish"
    "share/zsh/site-functions/_${n}-cli"
    "share/man/man1/${n}-cli*.1"
  ];
  app =
    n:
    {
      summary,
      extraFiles ? [ ],
      withMime ? true,
      dlopen ? [ ],
      smoke ? {
        kind = "window";
        wmClass = "ai.storyteller.${n}";
      },
      data ? [ ],
      dropped ? [ ],
      fonts ? true,
    }:
    rec {
      inherit
        summary
        dlopen
        smoke
        data
        dropped
        fonts
        ;
      bins = [
        n
        "${n}-cli"
      ];
      desktopId = "ai.storyteller.${n}";
      files = standard n bins ++ (if withMime then mime n else [ ]) ++ extraFiles;
    };
in
{
  dlopen.common = [
    "wayland"
    "libxkbcommon"
    "libx11"
    "libxcb"
    "libxcursor"
    "libxi"
    "libxrender"
    "libglvnd"
    "vulkan-loader"
    "dbus"
  ];

  apps = {
    photocraft = app "photocraft" {
      summary = "Edit photos and layered PSD documents";
      extraFiles = completions "photocraft";
    };
    vectorcraft = app "vectorcraft" {
      summary = "Draw and edit vector illustrations, SVG and PDF";
    };
    filmcraft = app "filmcraft" {
      summary = "Edit video, color and sound";
      # Hardware video decoding through VA-API, when present.
      dlopen = [ "libva" ];
      dropped = [ "install.sh" ];
    };
    lightcraft = app "lightcraft" {
      summary = "Organise photos and develop raw files, non-destructively";
    };
    pdfcraft = app "pdfcraft" {
      summary = "Read, organize, combine, split and secure PDFs";
      # Its OCR models, found at <binary>/../share/pdfcraft/models.
      data = [ "share/pdfcraft" ];
      extraFiles = [ "share/pdfcraft/models/*" ];
    };
    effectcraft = app "effectcraft" {
      summary = "Motion graphics and visual effects compositor";
      fonts = false;
    };
    anicraft = app "anicraft" {
      summary = "Draw and animate 2D vector art on a timeline";
      # It opens its own sample scene, and --screenshot writes that frame;
      # --renderer forces the backend, for the Vulkan and GL smokes.
      smoke = {
        kind = "window";
        wmClass = "ai.storyteller.anicraft";
        screenshot = true;
      };
    };
    designcraft = app "designcraft" {
      summary = "Lay out magazines, books and print documents";
      extraFiles = [ "share/thumbnailers/ai.storyteller.designcraft.thumbnailer" ];
    };
    figcraft = app "figcraft" {
      summary = "Design and prototype user interfaces";
      dlopen = [ "fontconfig" ];
    };
    texturecraft = app "texturecraft" {
      summary = "Paint PBR textures directly on 3D meshes";
      smoke = {
        kind = "window";
        wmClass = "texturecraft";
      };
    };
    materialcraft = app "materialcraft" {
      summary = "Design procedural PBR materials with node graphs";
      smoke = {
        kind = "window";
        wmClass = "materialcraft";
      };
    };
    soundcraft = app "soundcraft" {
      summary = "Record, edit and mix audio and MIDI";
      fonts = false;
      extraFiles = completions "soundcraft";
    };
    wordcraft = app "wordcraft" {
      summary = "Write and design documents; open and save Word files";
    };
    deckcraft = app "deckcraft" {
      summary = "Create and present slide decks";
    };
    cadcraft = app "cadcraft" {
      summary = "Draft, dimension and plot 2D drawings";
      extraFiles = completions "cadcraft";
    };
    gridcraft = app "gridcraft" {
      summary = "Calculate, analyse and chart data in workbooks";
    };
    craft-anything = app "craft-anything" {
      summary = "Find out how any software works, then craft your own";
      withMime = false;
    };
  };
}
