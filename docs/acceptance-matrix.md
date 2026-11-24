# Acceptance matrix

What each package is built from, on each system, as found in the real
archives before the package landed.
`pkgs/apps.nix` and the packages are checked against it: `<app>-files`
(the declared files), `<app>-libs` (every `dlopen` library resolves),
`<app>-smoke` (the readiness signal) and `as-shipped`.

Status: ✅ built, version-checked and smoke-tested here (x86_64, in the Nix
sandbox) · 🔲 inspected but not run here (aarch64: this machine can't run it;
branch CI runs the whole suite there).

Checked against upstream's releases on 2026-11-22. All archives are signed
the same way: `SHA256SUMS.txt` and `SHA256SUMS.txt.asc`, by the key in
`keys/` (primary `2B76741B414AAD6CD33E631213A005C0B9D7C3ED`, signing subkey
`568DC1F68F8FAECC797F3C7B006DAF6BB0EF334E`), identical in all 18
repositories; every pinned tarball has exactly one entry in the manifest,
equal to GitHub's digest.

## Common to every Craft App

- **Archive:** `<app>-<v>-linux-<arch>/` with `bin/` (the app and its `-cli`) and `share/` (desktop file, hicolor icons, AppStream metainfo, MIME package, `doc/<app>/` with the licences). The same layout on both systems.
- **Licences:** `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE` (MIT OR Apache-2.0); bundled fonts' `OFL-*.txt` where the app embeds fonts.
- **Linked:** glibc, libgcc_s, and libasound for the apps with audio. Everything else is `dlopen`ed.
- **Common `dlopen` set** (`dlopen.common` in `pkgs/apps.nix`): wayland (`libwayland-client.so.0`, `libwayland-egl.so.1`), libxkbcommon (`libxkbcommon.so.0`, `libxkbcommon-x11.so.0`), libx11 (`libX11.so.6`, `libX11-xcb.so.1`), libxcb, libxcursor, libxi, libxrender, libglvnd (`libEGL.so.1`, `libGL.so.1`), vulkan-loader, dbus. NVIDIA's CUDA and NVENC libraries (FilmCraft) are found in `/run/opengl-driver/lib`, added to the RPATH.
- **Version probe:** `<bin> --version` for the app and its `-cli`, with no display.
- **Smoke:** under Xvfb with Mesa's software renderer in the Nix sandbox, started with `APPIMAGE` set: the real program's environment has no `APPIMAGE` and has `CRAFT_UPDATE_MANAGED_BY=Nix` (read from `/proc/<pid>/environ` after the wrapper's exec), a window of the app's WM class maps and stays up 5 s, and the screen isn't blank (≥ 64 colours). No golden image.
- **Ways the smoke differs from what users run:** Mesa's drivers are set by path (users': `/run/opengl-driver`); no D-Bus system bus, sound card or network (update checks fail and are logged); the forced-GL smoke sets `LD_LIBRARY_PATH=${mesa}/lib` and `__GLX_VENDOR_LIBRARY_NAME=mesa` for glvnd, which users don't need.
- **Update check:** each app's updater (craft-libs `self_update.rs`) counts `/nix` as owned by a package manager; the prompt offers only Download (a browser), What's new and Later. The wrapper unsets an inherited `APPIMAGE`, the one path to an install.

## photocraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/photocraft.json](../versions/photocraft.json)

- **Release:** `storytold/photocraft` v0.23.1; assets `photocraft-0.23.1-linux-x86_64.tar.gz` (139 MB), `photocraft-0.23.1-linux-aarch64.tar.gz` (133 MB)
- **Layout:** top level `bin`, `share`; 46 files; aarch64 the same files
- **Binaries (x86_64):** `photocraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `photocraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1
- **Binaries (aarch64):** `photocraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `photocraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libvulkan.so.1
- **Smoke (x86_64):** window "PhotoCraft" mapped after 3.2 s (Xvfb's start included); 1139 colours; 9.6 s in all

## vectorcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/vectorcraft.json](../versions/vectorcraft.json)

- **Release:** `storytold/vectorcraft` v0.24.1; assets `vectorcraft-0.24.1-linux-x86_64.tar.gz` (158 MB), `vectorcraft-0.24.1-linux-aarch64.tar.gz` (150 MB)
- **Layout:** top level `bin`, `share`; 43 files; aarch64 the same files
- **Binaries (x86_64):** `vectorcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3; `vectorcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `vectorcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `vectorcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "VectorCraft" mapped after 4.0 s (Xvfb's start included); 3471 colours; 10.1 s in all

## filmcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/filmcraft.json](../versions/filmcraft.json)

- **Release:** `storytold/filmcraft` v0.20.1; assets `filmcraft-0.20.1-linux-x86_64.tar.gz` (112 MB), `filmcraft-0.20.1-linux-aarch64.tar.gz` (108 MB)
- **Layout:** top level `bin`, `install.sh`, `share`; 41 files; aarch64 the same files
- **Binaries (x86_64):** `filmcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3, libasound.so.2, libva.so.2, libva-drm.so.2, libcuda.so.1, libnvcuvid.so.1, libnvidia-encode.so.1; `filmcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libva.so.2, libva-drm.so.2, libcuda.so.1, libnvcuvid.so.1, libnvidia-encode.so.1
- **Binaries (aarch64):** `filmcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2, libva.so.2, libva-drm.so.2, libcuda.so.1, libnvcuvid.so.1, libnvidia-encode.so.1; `filmcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libvulkan.so.1, libva.so.2, libva-drm.so.2, libcuda.so.1, libnvcuvid.so.1, libnvidia-encode.so.1
- **Smoke (x86_64):** window "FilmCraft" mapped after 3.2 s (Xvfb's start included); 23700 colours; 9.4 s in all

## lightcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/lightcraft.json](../versions/lightcraft.json)

- **Release:** `storytold/lightcraft` v0.21.1; assets `lightcraft-0.21.1-linux-x86_64.tar.gz` (123 MB), `lightcraft-0.21.1-linux-aarch64.tar.gz` (117 MB)
- **Layout:** top level `bin`, `share`; 32 files; aarch64 the same files
- **Binaries (x86_64):** `lightcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `lightcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libvulkan.so.1
- **Binaries (aarch64):** `lightcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `lightcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libvulkan.so.1
- **Smoke (x86_64):** window "LightCraft" mapped after 3.2 s (Xvfb's start included); 8272 colours; 9.6 s in all

## pdfcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/pdfcraft.json](../versions/pdfcraft.json)

- **Release:** `storytold/pdfcraft` v0.21.1; assets `pdfcraft-0.21.1-linux-x86_64.tar.gz` (121 MB), `pdfcraft-0.21.1-linux-aarch64.tar.gz` (117 MB)
- **Layout:** top level `bin`, `share`; 36 files; aarch64 the same files
- **Binaries (x86_64):** `pdfcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3; `pdfcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `pdfcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `pdfcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "PdfCraft" mapped after 3.2 s (Xvfb's start included); 2377 colours; 9.4 s in all

## effectcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/effectcraft.json](../versions/effectcraft.json)

- **Release:** `storytold/effectcraft` v0.24.1; assets `effectcraft-0.24.1-linux-x86_64.tar.gz` (82 MB), `effectcraft-0.24.1-linux-aarch64.tar.gz` (76 MB)
- **Layout:** top level `bin`, `share`; 27 files; aarch64 the same files
- **Binaries (x86_64):** `effectcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3, libasound.so.2; `effectcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-client.so.0, libwayland-egl.so.1
- **Binaries (aarch64):** `effectcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `effectcraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libxcb.so.1, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1
- **Smoke (x86_64):** window "EffectCraft - Untitled Project.ecproj" mapped after 3.3 s (Xvfb's start included); 972 colours; 9.6 s in all

## anicraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/anicraft.json](../versions/anicraft.json)

- **Release:** `storytold/anicraft` v0.2.1; assets `anicraft-0.2.1-linux-x86_64.tar.gz` (20 MB), `anicraft-0.2.1-linux-aarch64.tar.gz` (18 MB)
- **Layout:** top level `bin`, `share`; 32 files; aarch64 the same files
- **Binaries (x86_64):** `anicraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3, libasound.so.2; `anicraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `anicraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libXrender.so.1, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `anicraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "AniCraft — Untitled" mapped after 3.2 s (Xvfb's start included); 2095 colours; 9.3 s in all

## designcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/designcraft.json](../versions/designcraft.json)

- **Release:** `storytold/designcraft` v0.20.1; assets `designcraft-0.20.1-linux-x86_64.tar.gz` (125 MB), `designcraft-0.20.1-linux-aarch64.tar.gz` (121 MB)
- **Layout:** top level `bin`, `share`; 32 files; aarch64 the same files
- **Binaries (x86_64):** `designcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `designcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `designcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `designcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "DesignCraft" mapped after 3.5 s (Xvfb's start included); 1166 colours; 9.6 s in all

## figcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/figcraft.json](../versions/figcraft.json)

- **Release:** `storytold/figcraft` v0.18.1; assets `figcraft-0.18.1-linux-x86_64.tar.gz` (102 MB), `figcraft-0.18.1-linux-aarch64.tar.gz` (99 MB)
- **Layout:** top level `bin`, `share`; 46 files; aarch64 the same files
- **Binaries (x86_64):** `figcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3, libfontconfig.so.1; `figcraft-cli`: NEEDED libgcc_s.so.1; dlopen libfontconfig.so.1
- **Binaries (aarch64):** `figcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libfontconfig.so.1; `figcraft-cli`: NEEDED libgcc_s.so.1; dlopen libfontconfig.so.1
- **Smoke (x86_64):** window "FigCraft" mapped after 3.2 s (Xvfb's start included); 4699 colours; 9.6 s in all

## texturecraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/texturecraft.json](../versions/texturecraft.json)

- **Release:** `storytold/texturecraft` v0.6.1; assets `texturecraft-0.6.1-linux-x86_64.tar.gz` (43 MB), `texturecraft-0.6.1-linux-aarch64.tar.gz` (41 MB)
- **Layout:** top level `bin`, `share`; 22 files; aarch64 the same files
- **Binaries (x86_64):** `texturecraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3; `texturecraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1
- **Binaries (aarch64):** `texturecraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `texturecraft-cli`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libwayland-egl.so.1, libvulkan.so.1
- **Smoke (x86_64):** window "TextureCraft" mapped after 5.9 s (Xvfb's start included); 43798 colours; 12.3 s in all

## materialcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/materialcraft.json](../versions/materialcraft.json)

- **Release:** `storytold/materialcraft` v0.4.1; assets `materialcraft-0.4.1-linux-x86_64.tar.gz` (22 MB), `materialcraft-0.4.1-linux-aarch64.tar.gz` (20 MB)
- **Layout:** top level `bin`, `share`; 21 files; aarch64 the same files
- **Binaries (x86_64):** `materialcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3; `materialcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `materialcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `materialcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "MaterialCraft" mapped after 3.5 s (Xvfb's start included); 5195 colours; 9.6 s in all

## soundcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/soundcraft.json](../versions/soundcraft.json)

- **Release:** `storytold/soundcraft` v0.20.1; assets `soundcraft-0.20.1-linux-x86_64.tar.gz` (22 MB), `soundcraft-0.20.1-linux-aarch64.tar.gz` (20 MB)
- **Layout:** top level `bin`, `share`; 33 files; aarch64 the same files
- **Binaries (x86_64):** `soundcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `soundcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `soundcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `soundcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "Untitled — SoundCraft" mapped after 3.2 s (Xvfb's start included); 2541 colours; 9.4 s in all

## wordcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/wordcraft.json](../versions/wordcraft.json)

- **Release:** `storytold/wordcraft` v0.18.1; assets `wordcraft-0.18.1-linux-x86_64.tar.gz` (118 MB), `wordcraft-0.18.1-linux-aarch64.tar.gz` (115 MB)
- **Layout:** top level `bin`, `share`; 32 files; aarch64 the same files
- **Binaries (x86_64):** `wordcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `wordcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `wordcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `wordcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "WordCraft" mapped after 3.4 s (Xvfb's start included); 1912 colours; 9.5 s in all

## deckcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/deckcraft.json](../versions/deckcraft.json)

- **Release:** `storytold/deckcraft` v0.18.1; assets `deckcraft-0.18.1-linux-x86_64.tar.gz` (105 MB), `deckcraft-0.18.1-linux-aarch64.tar.gz` (102 MB)
- **Layout:** top level `bin`, `share`; 47 files; aarch64 the same files
- **Binaries (x86_64):** `deckcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `deckcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `deckcraft`: NEEDED libasound.so.2, libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3, libasound.so.2; `deckcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "DeckCraft" mapped after 3.5 s (Xvfb's start included); 1844 colours; 9.6 s in all

## cadcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/cadcraft.json](../versions/cadcraft.json)

- **Release:** `storytold/cadcraft` v0.20.1; assets `cadcraft-0.20.1-linux-x86_64.tar.gz` (75 MB), `cadcraft-0.20.1-linux-aarch64.tar.gz` (72 MB)
- **Layout:** top level `bin`, `share`; 43 files; aarch64 the same files
- **Binaries (x86_64):** `cadcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `cadcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `cadcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `cadcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "CADCraft" mapped after 3.5 s (Xvfb's start included); 5355 colours; 9.6 s in all

## gridcraft: ✅ x86_64 · 🔲 aarch64 · pin [versions/gridcraft.json](../versions/gridcraft.json)

- **Release:** `storytold/gridcraft` v0.19.1; assets `gridcraft-0.19.1-linux-x86_64.tar.gz` (53 MB), `gridcraft-0.19.1-linux-aarch64.tar.gz` (51 MB)
- **Layout:** top level `bin`, `share`; 32 files; aarch64 the same files
- **Binaries (x86_64):** `gridcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `gridcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `gridcraft`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `gridcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "Book1" mapped after 3.2 s (Xvfb's start included); 860 colours; 9.4 s in all

## craft-anything: ✅ x86_64 · 🔲 aarch64 · pin [versions/craft-anything.json](../versions/craft-anything.json)

- **Release:** `storytold/craft-anything` v0.6.1; assets `craft-anything-0.6.1-linux-x86_64.tar.gz` (70 MB), `craft-anything-0.6.1-linux-aarch64.tar.gz` (67 MB)
- **Layout:** top level `bin`, `share`; 33 files; aarch64 the same files
- **Binaries (x86_64):** `craft-anything`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libdbus-1.so.3; `craft-anything-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `craft-anything`: NEEDED libgcc_s.so.1; dlopen libEGL.so.1, libX11.so.6, libX11-xcb.so.1, libXcursor.so.1, libXi.so.6, libxcb.so.1, libxkbcommon.so.0, libxkbcommon-x11.so.0, libwayland-client.so.0, libwayland-egl.so.1, libvulkan.so.1, libdbus-1.so.3; `craft-anything-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Smoke (x86_64):** window "Craft Anything" mapped after 3.5 s (Xvfb's start included); 1380 colours; 9.6 s in all

## artcraft-studio: ✅ x86_64 · 🔲 aarch64 · pin [versions/artcraft.json](../versions/artcraft.json)

- **Release:** `storytold/artcraft` artcraft-v0.41.1; assets `artcraft-0.41.1-linux-x86_64.tar.gz` (49 MB), `artcraft-0.41.1-linux-aarch64.tar.gz` (50 MB)
- **Layout:** top level `bin`, `share`; 6 files; aarch64 the same files
- **Binaries (x86_64):** `artcraft`: NEEDED libgdk-3.so.0, libgdk_pixbuf-2.0.so.0, libcairo.so.2, libgobject-2.0.so.0, libglib-2.0.so.0, libdbus-1.so.3, libwebkit2gtk-4.1.so.0, libgtk-3.so.0, libsoup-3.0.so.0, libgio-2.0.so.0, libjavascriptcoregtk-4.1.so.0, libgcc_s.so.1; dlopen libX11.so.6, libXi.so.6, libdbus-1.so.3, libgtk-3.so.0, libgdk-3.so.0, libcairo.so.2, libunity.so.9
- **Binaries (aarch64):** `artcraft`: NEEDED libgdk-3.so.0, libpango-1.0.so.0, libgdk_pixbuf-2.0.so.0, libcairo-gobject.so.2, libcairo.so.2, libgobject-2.0.so.0, libglib-2.0.so.0, libdbus-1.so.3, libwebkit2gtk-4.1.so.0, libgtk-3.so.0, libsoup-3.0.so.0, libgio-2.0.so.0, libjavascriptcoregtk-4.1.so.0, libgcc_s.so.1; dlopen libX11.so.6, libXi.so.6, libdbus-1.so.3, libgtk-3.so.0, libgdk-3.so.0, libcairo.so.2, libunity.so.9
- **Smoke (x86_64):** window "ArtCraft" mapped after 3.5 s (Xvfb's start included); 2025 colours; 24.8 s in all

## pdfcraft-cli: ✅ x86_64 · 🔲 aarch64 · pin [versions/pdfcraft.json](../versions/pdfcraft.json)

- **Release:** `storytold/pdfcraft` v0.21.1; assets `pdfcraft-cli-0.21.1-linux-x86_64.tar.gz` (46 MB), `pdfcraft-cli-0.21.1-linux-aarch64.tar.gz` (44 MB)
- **Layout:** top level `LICENSE-APACHE`, `LICENSE-MIT`, `NOTICE`, `OFL-biz-ud-mincho.txt`, `OFL-biz-ud-pgothic.txt`, `OFL-lxgw-wenkai-lite.txt`, `OFL-nanum-gothic.txt`, `OFL-noto-sans-arabic.txt`, `OFL-noto-sans-cjk-sc.txt`, `OFL-noto-sans-devanagari.txt`, `OFL-noto-sans-georgian.txt`, `OFL-noto-sans-hebrew.txt`, `OFL-noto-sans-symbols-2.txt`, `OFL-noto-sans-symbols.txt`, `OFL-noto-sans-thai.txt`, `OFL-shippori-mincho.txt`, `README.md`, `pdfcraft-cli`; 18 files; aarch64 the same files
- **Binaries (x86_64):** `pdfcraft-cli`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `pdfcraft-cli`: NEEDED libgcc_s.so.1; dlopen none

## figcraft-server: ✅ x86_64 · 🔲 aarch64 · pin [versions/figcraft.json](../versions/figcraft.json)

- **Release:** `storytold/figcraft` v0.18.1; assets `figcraft-server-0.18.1-linux-x86_64.tar.gz` (5 MB), `figcraft-server-0.18.1-linux-aarch64.tar.gz` (4 MB)
- **Layout:** top level `Caddyfile`, `LICENSE-APACHE`, `LICENSE-MIT`, `NOTICE`, `figcraft-backup.service`, `figcraft-backup.timer`, `figcraft-server`, `figcraft-server.service`, `install.sh`, `nginx.conf`, `server.md`; 11 files; aarch64 the same files
- **Binaries (x86_64):** `figcraft-server`: NEEDED libgcc_s.so.1; dlopen none
- **Binaries (aarch64):** `figcraft-server`: NEEDED libgcc_s.so.1; dlopen none

## Special cases

- **artcraft-studio** (Tauri, WebKitGTK 4.1): no `--version`; with no display it logs `Platform info: … artcraft_version: "<v>"` before GTK starts, which is its version probe. No licence files in the archive: LICENSE-APACHE, LICENSE-MIT and NOTICE are pinned from the tag's commit. Smoke: under `dbus-run-session` (nixpkgs' session config) and Xvfb, with WebKit's own sandbox on, a window of class `artcraft` ("ArtCraft") maps, the log says `Sizing and positioning window...` and names no missing GStreamer element, and Studio is still running after 20 s (WebKit paints slowly on llvmpipe; `LD_LIBRARY_PATH=${mesa}/lib` would stop it painting at all, so the window smokes don't set it). Its screenshot is kept but may be blank: with GStreamer's `autodetect` plugin (WebKit's automatic audio output, needed for the start page's video and sound), the page stays blank in the build sandbox, though it draws and plays on a desktop (checked by hand on 2026-11-22: with and without network and a sound device). GStreamer core, base, good, bad and libav are on its plugin path (wrapGAppsHook3). Offline, its calls to `api.storyteller.ai` fail without stopping the UI. Data: `~/Artcraft`, cookies in `~/.cache/ai.artcraft.app`, **WebKit cache `~/.local/share/ai.artcraft.app/WebKitCache`** (what the README says to clear for the analytics block). Its page assets are embedded Brotli-compressed; `scripts/studio-hosts.ts` reads `index.html` from them on both systems.
- **anicraft:** also takes `--screenshot out.png` of its own sample and `--renderer wgpu|gl`: two more smokes force each backend with only that backend's driver present, with loader evidence (`VK_LOADER_DEBUG=driver`: lavapipe's ICD found; `LD_DEBUG=libs`: Mesa's `libgallium` loaded).
- **craft-anything:** its `--screenshot` strings are for programs it builds, not for itself: window smoke only.
- **pdfcraft:** finds its OCR models at `<binary>/../share/pdfcraft/models`, so the programs stay in `bin/` (wrapProgram's `bin/.<name>-wrapped`).
- **filmcraft:** the archive's top-level `install.sh` is left out. Hardware decoding through VA-API (`libva.so.2`, `libva-drm.so.2`) and NVIDIA's NVDEC/NVENC (from `/run/opengl-driver/lib`) when present.
- **figcraft:** also `dlopen`s `libfontconfig.so.1`.
- **texturecraft, materialcraft:** WM class without the `ai.storyteller.` prefix (`texturecraft`, `materialcraft`). TextureCraft maps its window after about 6 s.
- **effectcraft, soundcraft:** no bundled fonts (no OFL files).
- **pdfcraft-cli:** a flat archive: the binary, licences (with the fonts' OFL files) and README.md (left out). From 0.22.0 it also has ATTRIBUTION.md and a `licenses/` folder of third-party licences, both installed with the licences. Real-command check: `text` and `render` on a fixture PDF.
- **figcraft-server:** a flat archive: the binary, licences, and deployment files for other systems (install.sh, systemd units, Caddyfile, nginx.conf, server.md), left out. Check: starts on sandbox loopback with a temporary `--data` and answers `GET /healthz` with `ok`.
- **Studio's hosts file block** (`hostFileBlockAnalytics`): checked through glibc and systemd-resolved by `ci.vmTests.resolver` (x86_64, a NixOS VM test in branch CI). One-off evidence, 2026-11-22: the loaders' caching (`www.googletagmanager.com/gtag/js`: `Cache-Control: private, max-age=900`; `www.clarity.ms/tag/…`: `no-cache, no-store`); Studio's job poller every 35 s when signed out, timed over 150 s; and `ci.vmTests.studioLoopback`: with the block on (the `files` path), both loaders connect to port 443 on the machine (SNI seen), and with a listener holding those handshakes open Studio's window is ready in 4.1 s, as with nothing listening.
- **Smoke signal:** the Craft Apps log no common "ready" line, so the smoke requires the app's window to map, stay up 5 s and draw a non-blank picture of its own window, which also proves rendering.
