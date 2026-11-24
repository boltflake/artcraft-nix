# The smoke: start one app in the Nix sandbox under Xvfb and a private D-Bus
# session, with Mesa's software renderers, and check that it gets ready.
# Sourced by lib/checks.nix's smoke derivations, which always succeed and
# leave status, log and (when there is one) screenshot.png in $out; a small
# dependent check fails on a failing status.
#
# Environment: PROG (the bin/ wrapper), WM_CLASS, NAME (for messages),
# TITLE (optional: the window's title must be this), READY_LOG (optional: a
# line the app's log must have, too), FAIL_LOG (optional: an extended regex
# the app's log must not match once it's up), BLANK_OK (optional: why a
# blank screenshot doesn't fail this app's smoke), SETTLE (seconds
# to stay up after the window maps), ARGS (extra arguments, one per line),
# SCREENSHOT_RENDERER (optional: instead, `PROG --renderer R --screenshot`
# must write a non-blank PNG and exit 0), RENDERER_EVIDENCE (a line the
# loader's debug output must have, proving that backend drew).
# The derivation must succeed whatever the app does (runCommand runs with
# errexit), so a failure still leaves its status and log.
set +e -u
mkdir -p "$out"
: > "$out/log"
say() { echo "$*" >> "$out/log"; }
finish() { echo "$1" > "$out/status"; [ "$1" = 0 ] || say "FAILED: $2"; exit 0; }

export HOME=$TMPDIR/home XDG_RUNTIME_DIR=$TMPDIR/run
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
unset WAYLAND_DISPLAY DISPLAY
export RUST_LOG=info

start=$(date +%s%N)
cat > "$TMPDIR/inner.sh" <<'INNER'
set -u
say() { echo "$*" >> "$out/log"; }
mapfile -t args < <(printf '%s' "${ARGS:-}")
if [ -n "${SCREENSHOT_RENDERER:-}" ]; then
  timeout 120 "$PROG" "${args[@]}" --renderer "$SCREENSHOT_RENDERER" --screenshot "$out/screenshot.png" > "$out/app.log" 2>&1
  s=$?
  [ "$s" = 0 ] || { say "$NAME --screenshot exited with status $s"; exit 1; }
  [ -s "$out/screenshot.png" ] || { say "$NAME wrote no screenshot"; exit 1; }
  exit 0
fi
# A process running as an AppImage passes APPIMAGE on; the wrapper must drop it.
APPIMAGE=/tmp/Other.AppImage setsid "$PROG" "${args[@]}" > "$out/app.log" 2>&1 &
pid=$!
# The app and its children go whatever happens next.
trap 'kill -TERM -- "-$pid" 2>/dev/null; sleep 1; kill -KILL -- "-$pid" 2>/dev/null' EXIT
# The wrapper execs the program in the same process.
for _ in $(seq 1 100); do
  case $(readlink "/proc/$pid/exe" 2>/dev/null) in *-wrapped) break ;; esac
  sleep 0.1
done
exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
case $exe in *-wrapped) ;; *) say "the program never started (exe: ${exe:-gone})"; exit 1 ;; esac
# Right after exec the kernel shows the new exe a moment before the new
# program's environment is in place, so an empty read means "not yet": read
# again (up to 5 s) before concluding anything.
env=
for _ in $(seq 1 50); do
  [ -e "/proc/$pid/exe" ] || break
  env=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null) || env=
  [ -n "$env" ] && break
  sleep 0.1
done
if [ -z "$env" ]; then
  if [ -e "/proc/$pid/exe" ]; then say "$NAME's environment stayed unreadable for 5 s"
  else say "$NAME exited right after starting, before its environment could be read ($(wc -l < "$out/app.log") lines of output)"; fi
  exit 1
fi
if grep -q '^APPIMAGE=' <<< "$env"; then say "APPIMAGE reached the program"; exit 1; fi
grep -qx 'CRAFT_UPDATE_MANAGED_BY=Nix' <<< "$env" || { say "CRAFT_UPDATE_MANAGED_BY isn't Nix"; exit 1; }
say "environment: APPIMAGE unset, CRAFT_UPDATE_MANAGED_BY=Nix ($exe)"
win=
for _ in $(seq 1 600); do
  win=$(xdotool search --onlyvisible --class "^$WM_CLASS\$" 2>/dev/null | head -1)
  [ -n "$win" ] && break
  kill -0 "$pid" 2>/dev/null || { say "$NAME exited before its window mapped"; exit 1; }
  sleep 0.1
done
[ -n "$win" ] || { say "no window of class $WM_CLASS within 60 s"; exit 1; }
title=$(xdotool getwindowname "$win")
say "window $win ($title) mapped after $(( ($(date +%s%N) - START) / 1000000 )) ms"
if [ -n "${TITLE:-}" ] && [ "$title" != "$TITLE" ]; then say "the window's title is \"$title\", not \"$TITLE\""; exit 1; fi
if [ -n "${READY_LOG:-}" ]; then
  for _ in $(seq 1 300); do grep -qF "$READY_LOG" "$out/app.log" && break; sleep 0.1; done
  grep -qF "$READY_LOG" "$out/app.log" || { say "the log never said: $READY_LOG"; exit 1; }
fi
sleep "${SETTLE:-5}"
kill -0 "$pid" 2>/dev/null || { say "$NAME exited after its window mapped"; exit 1; }
if [ -n "${FAIL_LOG:-}" ] && grep -qE "$FAIL_LOG" "$out/app.log"; then
  say "the log says: $(grep -m1 -E "$FAIL_LOG" "$out/app.log")"; exit 1
fi
# The app's own window, not the screen: what it drew.
import -window "$win" "$out/screenshot.png" || { say "no screenshot"; exit 1; }
exit 0
INNER
export START=$start
status=0
timeout 300 dbus-run-session --config-file="$DBUS_SESSION_CONF" -- \
  xvfb-run -a -s "-screen 0 1600x1000x24" bash "$TMPDIR/inner.sh" >> "$out/log" 2>&1 || status=$?
echo "$(( ($(date +%s%N) - start) / 1000000 )) ms" > "$out/wall"
[ "$status" = 0 ] || finish 1 "the smoke exited with status $status"
if [ -n "${RENDERER_EVIDENCE:-}" ] && ! grep -qF "$RENDERER_EVIDENCE" "$out/app.log"; then
  finish 1 "no evidence of the forced renderer ($RENDERER_EVIDENCE) in the app's log"
fi
# A screenshot that can't be read is a failure for every app, BLANK_OK or not.
colours=$(magick "$out/screenshot.png" -format '%k' info: 2>/dev/null) || finish 1 "the screenshot can't be read"
[[ $colours =~ ^[0-9]+$ ]] || finish 1 "the screenshot can't be read (\"$colours\")"
say "screenshot: $colours colours"
if [ "$colours" -lt 64 ]; then
  # BLANK_OK: the screenshot is kept for review, but a blank one isn't a
  # failure (Studio: see lib/package-checks.nix).
  [ -n "${BLANK_OK:-}" ] || finish 1 "the screenshot is blank ($colours colours)"
  say "the screenshot is blank ($colours colours), allowed here: $BLANK_OK"
fi
finish 0
