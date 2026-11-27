# doctor-scenarios: the doctor on fixture machines, from a clean NixOS to a
# confused one. Each scenario sets up a root (ARTCRAFT_DOCTOR_ROOT), a HOME,
# stub commands on PATH (flatpak, dbus-send, zenity, gsettings), and the
# copies of an app it needs; then checks the exit status and what's said.
{
  runCommand,
  stdenv,
  doctor,
}:
let
  # A program the doctor counts as artcraft-nix's (in the store, setting the
  # managed-update variables), and one from another Nix package.
  fakeOurs = runCommand "fake-artcraft-photocraft" { } ''
    mkdir -p $out/bin
    printf '#!${stdenv.shell}\nexport CRAFT_UPDATE_MANAGED_BY=Nix\n' > $out/bin/photocraft
    chmod +x $out/bin/photocraft
  '';
  # artcraft-nix's figcraft-server alone (a companion, no desktop app).
  fakeServer = runCommand "fake-artcraft-figcraft-server" { } ''
    mkdir -p $out/bin
    printf '#!${stdenv.shell}\nexport CRAFT_UPDATE_MANAGED_BY=Nix\n' > $out/bin/figcraft-server
    chmod +x $out/bin/figcraft-server
  '';
  fakeOther = runCommand "fake-nixpkgs-photocraft" { } ''
    mkdir -p $out/bin
    printf '#!${stdenv.shell}\necho photocraft\n' > $out/bin/photocraft
    chmod +x $out/bin/photocraft
  '';
in
runCommand "doctor-scenarios" { } ''
  set -u
  doctor=${doctor}/bin/artcraft-nix
  w=$(mktemp -d)
  reset() {
    rm -rf $w/root $w/home $w/stubs $w/local
    mkdir -p $w/root/etc $w/root/run/opengl-driver/lib $w/root/run/opengl-driver/share/vulkan/icd.d \
      $w/home $w/stubs $w/local
    touch $w/root/etc/NIXOS
    echo '{}' > $w/root/run/opengl-driver/share/vulkan/icd.d/lvp.json
    printf '127.0.0.1 localhost\n::1 localhost\n' > $w/root/etc/hosts
    # A desktop portal answers its Ping.
    printf '#!${stdenv.shell}\ncase "$*" in *portal.Desktop*Ping*) exit 0 ;; esac\nexit 1\n' > $w/stubs/dbus-send
    printf '#!${stdenv.shell}\nexit 0\n' > $w/stubs/flatpak
    chmod +x $w/stubs/*
    extra=()
    path="$w/stubs:${fakeOurs}/bin:/var/empty"
  }
  cmd=doctor
  run() { # name, expected status, [env assignments...]
    local name=$1 want=$2 got=0
    shift 2
    env -i HOME=$w/home PATH="$path" ARTCRAFT_DOCTOR_ROOT=$w/root "$@" $doctor $cmd > $w/out 2>&1 || got=$?
    echo "== $name (exit $got)"; cat $w/out
    [ "$got" = "$want" ] || { echo "$name: exit $got, expected $want"; exit 1; }
  }
  has() { grep -qF -- "$1" $w/out || { echo "missing: $1"; exit 1; }; }
  hasnt() { if grep -qF -- "$1" $w/out; then echo "unexpected: $1"; exit 1; fi; }

  # A clean NixOS with artcraft-nix's PhotoCraft.
  reset
  run clean 0
  has "ok: photocraft: artcraft-nix's"
  has "GL drivers in /run/opengl-driver"
  has "a desktop portal answers"
  has "no analytics block in /etc/hosts (off, as by default)"
  has "No problems found."
  # With no argument too (nix run .#doctor passes none).
  cmd=
  run clean-no-argument 0
  has "No problems found."
  cmd=doctor

  # Another Nix package's PhotoCraft first on PATH, hiding ours: a problem.
  reset
  path="$w/stubs:${fakeOther}/bin:${fakeOurs}/bin"
  run shadowed 1
  has "is another Nix package's"
  has "it hides artcraft-nix's"
  # The same without ours anywhere: only a note.
  reset
  path="$w/stubs:${fakeOther}/bin"
  run other-only 0
  has "note: photocraft at ${fakeOther}/bin/photocraft is another Nix package's"

  # A Flatpak, an AppImage and the launcher.
  reset
  printf '#!${stdenv.shell}\necho ai.storyteller.photocraft\necho org.other.App\n' > $w/stubs/flatpak
  mkdir -p $w/home/Applications $w/home/.local/share/applications
  touch $w/home/Applications/PhotoCraft-0.23.1-x86_64.AppImage
  touch $w/home/.local/share/applications/ai.storyteller.craft-launcher.desktop
  run outside 1
  has "Flatpak ai.storyteller.photocraft is installed"
  hasnt "org.other.App"
  has "AppImage $w/home/Applications/PhotoCraft-0.23.1-x86_64.AppImage"
  has "the ArtCraft Launcher is installed"
  # Other programs' AppImages with "craft" in their names aren't the apps'.
  reset
  mkdir -p $w/home/Applications
  touch $w/home/Applications/Minecraft-Launcher-x86_64.AppImage $w/home/Applications/CraftOS-PC.AppImage
  touch $w/home/Applications/Craft_Anything-1.0.0-x86_64.AppImage
  run appimages-named 1
  has "Craft_Anything-1.0.0-x86_64.AppImage"
  hasnt "Minecraft"
  hasnt "CraftOS"

  # NixOS without graphics drivers.
  reset
  rm -rf $w/root/run/opengl-driver
  run no-drivers 1
  has "no /run/opengl-driver"
  has "hardware.graphics.enable = true"

  # Another distribution: nixGL, and a distribution package in /usr/bin.
  # The doctor runs from a plain shell: not under nixGL is a reminder.
  reset
  rm $w/root/etc/NIXOS
  run no-nixgl 0
  has "note: not NixOS: start the apps through nixGL"
  # nixGLIntel's own environment: a store Mesa, no "nixGL" in any name.
  reset
  rm $w/root/etc/NIXOS
  run nixgl-intel 0 LIBGL_DRIVERS_PATH=/nix/store/abc-mesa-26.3.1/lib/dri __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/abc-mesa-26.3.1/share/glvnd/egl_vendor.d/50_mesa.json
  has "GL drivers from the Nix store set, as nixGL sets them"
  reset
  rm $w/root/etc/NIXOS
  run nixgl 0 NIXGL=1
  has "GL drivers from the Nix store set, as nixGL sets them"
  reset
  rm $w/root/etc/NIXOS
  mkdir -p $w/root/usr/bin && touch $w/root/usr/bin/photocraft
  run usr-bin-unowned 1 NIXGL=1
  has "$w/root/usr/bin/photocraft is installed outside Nix (no package manager here says it owns it)"
  printf '#!${stdenv.shell}\necho "photocraft: /usr/bin/photocraft"\n' > $w/stubs/dpkg-query && chmod +x $w/stubs/dpkg-query
  run deb 1 NIXGL=1
  has "$w/root/usr/bin/photocraft is installed by the deb package photocraft"

  # No portal (its name may be activatable, but the Ping doesn't answer):
  # zenity is enough; without it, a problem.
  reset
  printf '#!${stdenv.shell}\nexit 1\n' > $w/stubs/dbus-send
  run no-portal 1
  has "no desktop portal on the session bus and no zenity"
  printf '#!${stdenv.shell}\nexit 0\n' > $w/stubs/zenity && chmod +x $w/stubs/zenity
  run zenity 0
  has "zenity is on PATH"

  # Asked for, but /etc/hosts lacks it: a problem.
  reset
  mkdir -p $w/root/etc/artcraft-nix && touch $w/root/etc/artcraft-nix/analytics-block
  run block-asked-missing 1
  has "www.clarity.ms isn't in /etc/hosts, though the module's option asked for the block"
  hasnt "off, as by default"
  # Asked for, and /etc/hosts can't be read: that one problem, no list of
  # names missing.
  reset
  mkdir -p $w/root/etc/artcraft-nix && touch $w/root/etc/artcraft-nix/analytics-block
  chmod 000 $w/root/etc/hosts
  run block-asked-unreadable 1
  has "/etc/hosts can't be read, so the analytics block can't be checked"
  hasnt "isn't in /etc/hosts"
  hasnt "the block"
  has "1 problem(s) found."
  chmod 644 $w/root/etc/hosts
  # A folder where /etc/hosts should be: the same one problem.
  rm $w/root/etc/hosts && mkdir $w/root/etc/hosts
  run block-asked-folder 1
  has "/etc/hosts can't be read, so the analytics block can't be checked"
  has "1 problem(s) found."
  # Not asked for: only a note.
  rm $w/root/etc/artcraft-nix/analytics-block
  run block-unasked-folder 0
  has "note: /etc/hosts can't be read"
  # No /etc/hosts at all: no names listed. Asked for, each is missing;
  # not asked for, the block is off.
  rmdir $w/root/etc/hosts
  run unasked-no-hosts 0
  has "no analytics block in /etc/hosts (off, as by default)"
  touch $w/root/etc/artcraft-nix/analytics-block
  run block-asked-no-hosts 1
  has "www.clarity.ms isn't in /etc/hosts, though the module's option asked for the block"
  hasnt "can't be"
  # A dangling link, or one through a folder this user can't enter: one
  # finding, a problem when asked for and a note when not.
  ln -s $w/nowhere $w/root/etc/hosts
  run block-asked-dangling 1
  has "/etc/hosts is a link that can't be followed (to $w/nowhere)"
  has "1 problem(s) found."
  mkdir -p $w/locked && printf '0.0.0.0 www.clarity.ms\n' > $w/locked/hosts && chmod 000 $w/locked
  ln -sfn $w/locked/hosts $w/root/etc/hosts
  run block-asked-locked 1
  has "/etc/hosts is a link that can't be followed (to $w/locked/hosts)"
  has "1 problem(s) found."
  rm $w/root/etc/artcraft-nix/analytics-block
  run unasked-locked 0
  has "note: /etc/hosts is a link that can't be followed"
  hasnt "off, as by default"
  chmod 755 $w/locked

  # A server with only the headless companions: no GL drivers or portal
  # needed, so notes.
  reset
  rm -rf $w/root/run/opengl-driver
  printf '#!${stdenv.shell}\nexit 1\n' > $w/stubs/dbus-send
  path="$w/stubs:${fakeServer}/bin"
  run companions-only 0
  has "only the headless companions are installed"

  # The analytics block: complete (the module's marker says it was asked for).
  reset
  mkdir -p $w/root/etc/artcraft-nix && touch $w/root/etc/artcraft-nix/analytics-block
  printf '0.0.0.0 www.googletagmanager.com www.clarity.ms\n:: www.googletagmanager.com www.clarity.ms\n' >> $w/root/etc/hosts
  run block-complete 0
  has "www.googletagmanager.com: listed at 0.0.0.0 and ::"
  has "the block is complete (2 names)"
  # With a proxy in the environment, in GNOME's settings and in KDE's.
  run block-proxy-env 0 https_proxy=http://proxy:3128
  has "a proxy is configured (https_proxy)"
  printf "#!${stdenv.shell}\necho \"'manual'\"\n" > $w/stubs/gsettings && chmod +x $w/stubs/gsettings
  run block-proxy-gnome 0
  has "GNOME's proxy setting ('manual')"
  rm $w/stubs/gsettings
  mkdir -p $w/home/.config && printf '[Proxy Settings]\nProxyType=1\n' > $w/home/.config/kioslaverc
  run block-proxy-kde 0
  has "KDE's proxy setting"

  # IPv4 only, asked for: partial is a problem.
  reset
  mkdir -p $w/root/etc/artcraft-nix && touch $w/root/etc/artcraft-nix/analytics-block
  printf '0.0.0.0 www.googletagmanager.com www.clarity.ms\n' >> $w/root/etc/hosts
  run block-ipv4-only 1
  has "www.clarity.ms: listed at only 0.0.0.0"
  has "the block is partial (0 of 2 names at both addresses)"

  # The same from a blocklist (networking.stevenblack), not the option:
  # only a note.
  reset
  printf '0.0.0.0 www.googletagmanager.com\n0.0.0.0 www.clarity.ms\n' >> $w/root/etc/hosts
  run blocklist-ipv4 0
  has "note: www.clarity.ms: listed at only 0.0.0.0"
  # A name at a block address and a real one, asked for: mapped elsewhere.
  reset
  mkdir -p $w/root/etc/artcraft-nix && touch $w/root/etc/artcraft-nix/analytics-block
  printf '0.0.0.0 www.googletagmanager.com www.clarity.ms\n:: www.googletagmanager.com www.clarity.ms\n142.250.1.1 www.googletagmanager.com\n' >> $w/root/etc/hosts
  run block-elsewhere 1
  has "www.googletagmanager.com is mapped elsewhere in /etc/hosts too (142.250.1.1)"

  # A disclosed host blocked by hand changes nothing in the report, and no
  # proxy note when nothing is blocked.
  reset
  printf '0.0.0.0 www.google-analytics.com\n' >> $w/root/etc/hosts
  run disclosed-only 0 https_proxy=http://proxy:3128
  has "no analytics block in /etc/hosts"
  hasnt "www.google-analytics.com"
  hasnt "a proxy is configured"

  touch $out
''
