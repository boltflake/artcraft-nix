# artcraft-nix doctor: why isn't an ArtCraft app working? Read-only: it
# never writes anywhere and never needs sudo. It runs no app. Exit status 1
# if there's a problem, 0 otherwise (notes don't count).
#
# What this build knows comes from its data file (sourced below): NIXPKGS
# (unstable or stable), PACKAGES (lines "name version storepath bin…"),
# BLOCKED (the analytics names hostFileBlockAnalytics puts in /etc/hosts),
# and COMPANIONS (the headless packages, lib/packages.nix).
# ARTCRAFT_DOCTOR_ROOT (tests only) is prefixed to the system paths it
# reads; commands (flatpak, gsettings, dbus-send, zenity, rpm, dpkg-query)
# come from PATH, so tests stub them.
# Paths with a line break in a name (on PATH, links' targets) aren't
# handled: such a path may be split into several, or lose a line break at
# its end (init refuses such folders).
# shellcheck source=/dev/null
. @data@
root=${ARTCRAFT_DOCTOR_ROOT:-}
home=${HOME:-}
problems=0

ok() { printf '  ok: %s\n' "$1"; }
note() { printf '  note: %s\n' "$1"; }
problem() {
  problems=$((problems + 1))
  printf '  PROBLEM: %s\n' "$1"
  shift
  for fix in "$@"; do printf '    -> %s\n' "$fix"; done
}
section() { printf '\n%s\n' "$1"; }

nixos=0
[ -e "$root/etc/NIXOS" ] && nixos=1

echo "artcraft-nix doctor (this build: nixpkgs $NIXPKGS)"

# Every executable file called $1 on PATH, in order, symlinks resolved.
onPath() {
  local IFS=: dir seen=" "
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    case $seen in *" $dir "*) continue ;; esac
    seen="$seen$dir "
    if [ -x "$dir/$1" ] && [ ! -d "$dir/$1" ]; then
      printf '%s\t%s\n' "$dir/$1" "$(readlink -f -- "$dir/$1" 2>/dev/null || printf '%s' "$dir/$1")"
    fi
  done
}
# Whether a resolved program is one of this flake's wrappers: in the store,
# and setting the managed-update variables that only artcraft-nix sets.
ours() {
  case $1 in /nix/store/*) ;; *) return 1 ;; esac
  grep -qs 'CRAFT_UPDATE_MANAGED_BY' "$1"
}

section "The apps on PATH"
installed=0 desktop=0
while read -r name version store bins; do
  [ -n "$name" ] || continue
  for b in $bins; do
    mapfile -t found < <(onPath "$b")
    [ ${#found[@]} -gt 0 ] || continue
    installed=$((installed + 1))
    [[ " $COMPANIONS " == *" $name "* ]] || desktop=1
    first=${found[0]#*$'\t'}
    shown=${found[0]%%$'\t'*}
    if ours "$first"; then
      v=${first#/nix/store/*-}
      v=${v%%/*}
      if [ "$first" = "$store/bin/$b" ]; then
        ok "$b: artcraft-nix's ($name $version)"
      else
        ok "$b: artcraft-nix's (${v}; this doctor knows $name $version)"
      fi
    else
      shadowed=
      for extra in "${found[@]:1}"; do ours "${extra#*$'\t'}" && shadowed=${extra%%$'\t'*}; done
      case $first in
        /nix/store/*) what="another Nix package's (nixpkgs packages some of the apps too)" ;;
        *) what="not from Nix (a deb, rpm, AppImage or manual install)" ;;
      esac
      if [ -n "$shadowed" ]; then
        problem "$b at $shown is $what, and it hides artcraft-nix's at $shadowed ($first)" \
          "remove that copy, or put artcraft-nix's first on PATH (the overlay replaces nixpkgs' for you)"
      else
        note "$b at $shown is $what, not artcraft-nix's ($first)"
      fi
    fi
    for extra in "${found[@]:1}"; do
      p=${extra#*$'\t'}
      ours "$p" || note "$b: another copy further down PATH, at ${extra%%$'\t'*} ($p)"
    done
  done
done <<< "$PACKAGES"
[ "$installed" -gt 0 ] || note "no ArtCraft app is on PATH (install one with the module, or try one with nix run github:boltflake/artcraft-nix#photocraft)"

# Only the headless companions (a server): no graphics or file dialogs
# needed, so their checks below are notes.
headless=0
[ "$installed" -gt 0 ] && [ "$desktop" = 0 ] && headless=1
needed() { if [ "$headless" = 1 ]; then note "$1 (only the headless companions are installed: they don't need it)"; else problem "$@"; fi; }

section "Copies outside Nix"
outside=0
if command -v flatpak >/dev/null 2>&1; then
  flatpaks=$(flatpak list --app --columns=application 2>/dev/null | grep -E '^(ai\.storyteller\.|ai\.artcraft\.)' || true)
  if [ -n "$flatpaks" ]; then
    outside=1
    while read -r f; do
      problem "Flatpak $f is installed beside artcraft-nix's" \
        "its menu entry may shadow the Nix one; remove it with: flatpak uninstall $f"
    done <<< "$flatpaks"
  fi
fi
# An AppImage of one of the apps: its name, less the version and
# architecture, is an app's (PhotoCraft-0.23.1-x86_64.AppImage), ignoring
# case, hyphens and underscores; Studio's is ArtCraft's. Nothing else
# (Minecraft-Launcher, CraftOS-PC) counts.
appimage_keys=" artcraft "
while read -r n _; do [ -n "$n" ] && appimage_keys="$appimage_keys${n//-/} "; done <<< "$PACKAGES"
for dir in "$home/Applications" "$home/AppImages" "$home/.local/bin"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' f; do
    key=$(basename "$f")
    key=${key,,}
    key=$(sed -E 's/\.appimage$//; s/[-_.]v?[0-9].*$//; s/[-_]//g' <<< "$key")
    [[ $appimage_keys == *" $key "* ]] || continue
    outside=1
    problem "AppImage $f" \
      "it updates itself and can shadow the Nix app; delete it if artcraft-nix's is the one you use"
  done < <(find "$dir" -maxdepth 1 -type f -iname '*.AppImage' -print0 2>/dev/null)
done
launcher=
for f in "$home/.local/share/applications/ai.storyteller.craft-launcher.desktop" \
  "$root/usr/share/applications/ai.storyteller.craft-launcher.desktop" \
  "$root/usr/bin/craft-launcher"; do
  [ -e "$f" ] && launcher=$f
done
if [ -n "$launcher" ]; then
  outside=1
  problem "the ArtCraft Launcher is installed ($launcher)" \
    "its Install button puts Flatpaks or AppImages beside the Nix apps; artcraft-nix updates them instead"
fi
if [ "$nixos" = 0 ]; then
  while read -r name _ _ bins; do
    for b in $bins; do
      if [ -e "$root/usr/bin/$b" ]; then
        outside=1
        owner=
        if command -v dpkg-query >/dev/null 2>&1; then
          owner=$(dpkg-query -S "/usr/bin/$b" 2>/dev/null | head -1 | cut -d: -f1) || true
          [ -z "$owner" ] || owner="the deb package $owner"
        fi
        if [ -z "$owner" ] && command -v rpm >/dev/null 2>&1; then
          owner=$(rpm -qf "/usr/bin/$b" 2>/dev/null) || owner=
          [ -z "$owner" ] || owner="the rpm package $owner"
        fi
        if [ -n "$owner" ]; then
          problem "$root/usr/bin/$b is installed by $owner" \
            "remove that package, so menus and PATH find artcraft-nix's"
        else
          problem "$root/usr/bin/$b is installed outside Nix (no package manager here says it owns it)" \
            "remove that copy, so menus and PATH find artcraft-nix's"
        fi
      fi
    done
  done <<< "$PACKAGES"
fi
[ "$outside" = 1 ] || ok "no Flatpak, AppImage, launcher or distribution package of the apps"

section "Graphics drivers"
icds=()
for d in "$root/run/opengl-driver/share/vulkan/icd.d" "$root/usr/share/vulkan/icd.d" "$root/etc/vulkan/icd.d"; do
  [ -d "$d" ] && for f in "$d"/*.json; do [ -e "$f" ] && icds+=("$f"); done
done
if [ "$nixos" = 1 ]; then
  if [ -d "$root/run/opengl-driver/lib" ]; then
    ok "GL drivers in /run/opengl-driver"
  else
    needed "no /run/opengl-driver: the apps can't find GL or Vulkan drivers" \
      "set hardware.graphics.enable = true (the module does it for you) and rebuild"
  fi
  if [ ${#icds[@]} -gt 0 ]; then ok "Vulkan drivers: ${#icds[@]} ICD file(s)"; else note "no Vulkan driver (ICD); the apps fall back to OpenGL"; fi
else
  # nixGL's wrappers point GL at a Mesa (or NVIDIA driver) in the store:
  # nixGLIntel sets LIBGL_DRIVERS_PATH and __EGL_VENDOR_LIBRARY_FILENAMES,
  # neither naming nixGL.
  if [ -n "${NIXGL:-}" ] || [[ ${LD_LIBRARY_PATH:-} == *nixGL* ]] || [[ ${__EGL_VENDOR_LIBRARY_FILENAMES:-} == *nixGL* ]] || [[ ${__EGL_VENDOR_LIBRARY_DIRS:-} == *nixGL* ]] \
    || [[ ${LIBGL_DRIVERS_PATH:-} == /nix/store/* ]] || [[ ${__EGL_VENDOR_LIBRARY_FILENAMES:-} == /nix/store/* ]]; then
    ok "this shell has GL drivers from the Nix store set, as nixGL sets them"
  else
    # The doctor itself runs from a plain shell: a reminder, not a problem.
    note "not NixOS: start the apps through nixGL, or they can't load your system's GL and Vulkan drivers (see the README, \"Nix on another distribution\")"
  fi
fi

section "File dialogs"
# A real call, bounded: a name that's only activatable may not start.
if dbus-send --session --print-reply --reply-timeout=3000 --dest=org.freedesktop.portal.Desktop \
  /org/freedesktop/portal/desktop org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
  ok "a desktop portal answers on the session bus"
elif command -v zenity >/dev/null 2>&1; then
  ok "no desktop portal, but zenity is on PATH: file dialogs use it"
else
  needed "no desktop portal on the session bus and no zenity: Open and Save dialogs won't appear" \
    "enable your desktop's portal (xdg.portal.enable = true with its backend), or install zenity"
fi

section "Studio's analytics block (hostFileBlockAnalytics)"
hosts=$root/etc/hosts
# Whether this machine asked for the block: the module's option writes this
# marker. Without it, a hosts file that lists the names some other way (a
# blocklist such as networking.stevenblack) is only noted.
asked=0
[ -e "$root/etc/artcraft-nix/analytics-block" ] && asked=1
gap() { if [ "$asked" = 1 ]; then problem "$@"; else note "$1"; fi; }
complete=0 partial=0
# Read once: a file that can't be read (or a folder in its place), or a
# link that can't be followed (dangling, or through a folder this user
# can't enter), is that one finding only, since every name would read as
# missing. No /etc/hosts at all lists no names.
hostsText=
hostsOk=1
if [ ! -e "$hosts" ] && [ ! -L "$hosts" ]; then
  :
elif [ ! -e "$hosts" ]; then
  hostsOk="link"
elif [ ! -f "$hosts" ] || ! hostsText=$(cat -- "$hosts" 2> /dev/null); then
  hostsOk=0
fi
if [ "$hostsOk" = link ]; then
  gap "/etc/hosts is a link that can't be followed (to $(readlink -- "$hosts" || echo '?')), so the analytics block can't be checked" \
    "rebuild, and check that nothing replaces /etc/hosts; if the target exists, check its folders' permissions"
elif [ "$hostsOk" = 0 ]; then
  gap "/etc/hosts can't be read, so the analytics block can't be checked" "check its permissions"
else
  for name in $BLOCKED; do
    v4=0 v6=0 other=
    while read -r addr rest; do
      case $addr in '' | \#*) continue ;; esac
      for h in $rest; do
        case $h in \#*) break ;; esac
        [ "$h" = "$name" ] || continue
        case $addr in
          0.0.0.0) v4=1 ;;
          ::) v6=1 ;;
          *) other="$other $addr" ;;
        esac
      done
    done <<< "$hostsText"
    if [ -n "$other" ]; then
      partial=$((partial + 1))
      gap "$name is mapped elsewhere in /etc/hosts too (${other# }), which may win" \
        "remove that entry (networking.hosts, extraHosts or hostFiles)"
    elif [ "$v4" = 1 ] && [ "$v6" = 1 ]; then
      complete=$((complete + 1))
      ok "$name: listed at 0.0.0.0 and ::"
    elif [ "$v4" = 0 ] && [ "$v6" = 0 ]; then
      # Asked for, and not there at all.
      [ "$asked" = 1 ] && problem "$name isn't in /etc/hosts, though the module's option asked for the block" \
        "rebuild, and check that nothing replaces /etc/hosts (networking.hostFiles, a hand-written file)"
    elif [ "$v4" = 1 ] || [ "$v6" = 1 ]; then
      partial=$((partial + 1))
      gap "$name: listed at only $([ "$v4" = 1 ] && echo 0.0.0.0 || echo ::), so a lookup for the other address family goes to DNS" \
        "list it at both 0.0.0.0 and :: (the module does both)"
    fi
  done
  n=$(wc -w <<< "$BLOCKED")
  if [ "$complete" = "$n" ]; then
    ok "the block is complete ($n names); it doesn't apply to programs that resolve names themselves"
  elif [ "$complete" = 0 ] && [ "$partial" = 0 ] && [ "$asked" = 0 ]; then
    ok "no analytics block in /etc/hosts (off, as by default)"
  elif [ "$complete" = 0 ] && [ "$partial" = 0 ]; then
    note "the block the module's option asked for isn't in /etc/hosts at all"
  else
    note "the block is partial ($complete of $n names at both addresses)"
  fi
  if [ $((complete + partial)) -gt 0 ]; then
    proxy=
    for v in http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; do
      [ -n "${!v:-}" ] && proxy="$proxy $v"
    done
    if command -v gsettings >/dev/null 2>&1; then
      mode=$(gsettings get org.gnome.system.proxy mode 2>/dev/null || true)
      case $mode in "'manual'" | "'auto'") proxy="$proxy GNOME's proxy setting ($mode)" ;; esac
    fi
    kio=$home/.config/kioslaverc
    if [ -r "$kio" ] && grep -qE '^ProxyType=[1-4]' "$kio"; then proxy="$proxy KDE's proxy setting"; fi
    if [ -n "$proxy" ]; then
      note "a proxy is configured (${proxy# }): a proxy resolves names itself, so the block may not apply through it"
    fi
  fi
fi

echo
if [ "$problems" -gt 0 ]; then
  echo "$problems problem(s) found."
  exit 1
fi
echo "No problems found."
