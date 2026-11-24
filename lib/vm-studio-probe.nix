# The local-machine side effect of hostFileBlockAnalytics: a one-off
# probe, not part of any suite.
#
#   nix build .#legacyPackages.x86_64-linux.ci.vmTests.studioLoopback
#
# A NixOS VM on the `files` name-service path (not resolved, where blocked
# names get no address and nothing connects) with the block on. 0.0.0.0 and
# :: mean this machine there, so Studio's loaders connect to port 443 here.
# Twice: with nothing on 443 (refused, the fast case), and with a listener
# that logs each connection's TLS SNI and then holds the handshake open
# without answering (the slow case). Studio's window must be ready within
# the smoke's deadline both times. A run where the listener sees no loader's
# SNI is inconclusive, not a pass.
{ self, pkgs }:
let
  studio = self.packages.${pkgs.stdenv.hostPlatform.system}.artcraft-studio;
  listener = pkgs.writeText "hold-443.py" ''
    import socket, sys, threading, time
    log = open("/tmp/sni.log", "a", buffering=1)
    names = [b"www.googletagmanager.com", b"www.clarity.ms"]
    def serve(family, addr):
        s = socket.socket(family, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        s.bind((addr, 443)); s.listen(64)
        held = []
        while True:
            c, peer = s.accept()
            c.settimeout(5)
            try:
                data = c.recv(4096)
            except Exception:
                data = b""
            # The ClientHello carries the SNI in the clear.
            sni = [n.decode() for n in names if n in data]
            log.write(f"{time.time():.1f} connection from {peer[0]} sni={','.join(sni) or '-'}\n")
            held.append(c)  # never answered, never closed: the slow case
    threading.Thread(target=serve, args=(socket.AF_INET6, "::"), daemon=True).start()
    serve(socket.AF_INET, "0.0.0.0")
  '';
in
pkgs.testers.runNixOSTest {
  name = "artcraft-studio-loopback";
  nodes.machine = {
    imports = [ self.nixosModules.default ];
    programs.artcraft.hostFileBlockAnalytics = true;
    virtualisation.memorySize = 3072;
    virtualisation.cores = 2;
    environment.systemPackages = with pkgs; [
      xvfb-run
      xdotool
      python3
      dbus
    ];
    hardware.graphics.enable = true;
  };
  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.succeed("getent ahostsv4 www.googletagmanager.com | grep -q 0.0.0.0")

    def studio_ready(label):
        machine.succeed("rm -rf /root/Artcraft /root/.local/share/ai.artcraft.app /root/.cache/ai.artcraft.app")
        start = float(machine.succeed("date +%s.%N"))
        # A unit of its own, so it outlives the command that starts it.
        machine.succeed(
            f"systemd-run --unit=studio-{label} --setenv=HOME=/root --setenv=PATH=/run/current-system/sw/bin "
            f"sh -c 'dbus-run-session -- xvfb-run -a -s \"-screen 0 1600x1000x24\" ${studio}/bin/artcraft > /tmp/studio-{label}.log 2>&1'"
        )
        machine.wait_until_succeeds(f"grep -q 'Sizing and positioning window' /tmp/studio-{label}.log", timeout=90)
        took = float(machine.succeed("date +%s.%N")) - start
        # Let the page load and try its loaders.
        machine.sleep(20)
        alive = machine.succeed(f"systemctl is-active studio-{label} || true").strip()
        print(machine.succeed(f"tail -5 /tmp/studio-{label}.log"))
        machine.succeed(f"systemctl stop studio-{label} || true")
        print(f"{label}: ready after {took:.1f} s; still running 20 s later: {alive}")
        assert took < 60, f"{label}: not ready within the smoke's 60 s deadline ({took:.1f} s)"
        assert alive == "active", f"{label}: Studio exited"
        return took

    refused = studio_ready("refused")
    machine.succeed("(python3 ${listener} > /tmp/listener.out 2>&1 &) ; sleep 1")
    held = studio_ready("held")
    sni_log = machine.succeed("cat /tmp/sni.log || true")
    print("listener log:\n" + sni_log)
    loaders = [l for l in sni_log.splitlines() if "sni=-" not in l]
    if not loaders:
        print("INCONCLUSIVE: the listener saw no loader's SNI")
    else:
        print(f"PASS: {len(loaders)} loader connection(s) held open; Studio ready after {held:.1f} s (refused: {refused:.1f} s)")
  '';
}
