# The resolver, once: a NixOS VM test with a fixture DNS server that answers
# the blocked names and an unlisted one. Too heavy for `checks` (it needs
# KVM); branch CI runs it on x86_64:
#
#   nix build .#legacyPackages.x86_64-linux.ci.vmTests.resolver
#
# With hostFileBlockAnalytics off, the names reach the fixture on both the
# `files` path (NixOS's default name service) and systemd-resolved's (the
# positive control). With it on, separate IPv4 and IPv6 lookups (no
# AI_ADDRCONFIG) give 0.0.0.0 or :: on the `files` path, and no address with
# resolved; on both no fixture address comes back, and an unlisted name
# still resolves. It stops at glibc and resolved: a lookup trace of
# Studio showed it resolving through getaddrinfo.
{ self, pkgs }:
let
  hostsList = pkgs.lib.importJSON ../shared/studio-hosts.json;
  blocked = map (h: h.host) (builtins.filter (h: h.status == "blocked") hostsList.hosts);
  unlisted = "unlisted.example";
  fixture4 = "10.0.0.53";
  fixture6 = "fd00::53";
  client =
    { block, resolved }:
    { nodes, ... }:
    {
      imports = [ self.nixosModules.default ];
      programs.artcraft.hostFileBlockAnalytics = block;
      networking.nameservers = [ nodes.dns.networking.primaryIPAddress ];
      services.resolved.enable = resolved;
      environment.systemPackages = [ pkgs.python3 ];
    };
  lookup = pkgs.writeText "lookup.py" ''
    import socket, sys
    name, family = sys.argv[1], {"4": socket.AF_INET, "6": socket.AF_INET6}[sys.argv[2]]
    try:
        # flags=0: no AI_ADDRCONFIG.
        found = sorted({a[4][0] for a in socket.getaddrinfo(name, None, family, 0, 0, 0)})
    except socket.gaierror as e:
        found = []
    print(" ".join(found) or "-")
  '';
in
pkgs.testers.runNixOSTest {
  name = "artcraft-hosts-resolver";
  nodes = {
    dns = {
      networking.firewall.allowedUDPPorts = [ 53 ];
      networking.firewall.allowedTCPPorts = [ 53 ];
      services.dnsmasq = {
        enable = true;
        resolveLocalQueries = false;
        settings = {
          no-resolv = true;
          address =
            map (n: "/${n}/${fixture4}") (blocked ++ [ unlisted ])
            ++ map (n: "/${n}/${fixture6}") (blocked ++ [ unlisted ]);
        };
      };
    };
    filesOff = client {
      block = false;
      resolved = false;
    };
    filesOn = client {
      block = true;
      resolved = false;
    };
    resolvedOff = client {
      block = false;
      resolved = true;
    };
    resolvedOn = client {
      block = true;
      resolved = true;
    };
  };
  testScript = ''
    import shlex
    blocked = ${builtins.toJSON blocked}
    start_all()
    dns.wait_for_unit("dnsmasq.service")
    dns.wait_for_open_port(53)
    clients = [filesOff, filesOn, resolvedOff, resolvedOn]
    for m in clients:
        m.wait_for_unit("multi-user.target")
    for m in [resolvedOff, resolvedOn]:
        m.wait_for_unit("systemd-resolved.service")

    def look(m, name, fam):
        return m.succeed(f"python3 ${lookup} {shlex.quote(name)} {fam}").strip()

    def expect(m, name, fam, want):
        got = look(m, name, fam)
        assert got == want, f"{m.name}: {name} IPv{fam}: got {got}, expected {want}"
        print(f"{m.name}: {name} IPv{fam} -> {got}")

    fixture = {"4": "${fixture4}", "6": "${fixture6}"}
    # Positive control: off, the names reach the fixture on both paths.
    for m in [filesOff, resolvedOff]:
        for n in blocked + ["${unlisted}"]:
            for fam in "46":
                expect(m, n, fam, fixture[fam])
    # On, the files path: 0.0.0.0 and ::.
    for n in blocked:
        expect(filesOn, n, "4", "0.0.0.0")
        expect(filesOn, n, "6", "::")
    # On, resolved: no address at all.
    for n in blocked:
        for fam in "46":
            expect(resolvedOn, n, fam, "-")
    # Unlisted names still resolve, on both paths.
    for m in [filesOn, resolvedOn]:
        for fam in "46":
            expect(m, "${unlisted}", fam, fixture[fam])
  '';
}
