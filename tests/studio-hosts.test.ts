// New-tracker detection (scripts/studio-hosts.ts): the comparison with the
// committed list. (The extraction itself was settled against Studio 0.41.1
// on both systems; it needs the binary, so it runs in the resolve job.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compare, embeddedAssets, hostsIn, listed } from "../scripts/studio-hosts.ts";

const list = JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "studio-hosts.json"), "utf8")).hosts;

test("the committed list: blocked names only the two loaders; a wildcard is never blocked", () => {
  assert.deepEqual(list.filter((h: any) => h.status === "blocked").map((h: any) => h.host).sort(), ["www.clarity.ms", "www.googletagmanager.com"]);
  for (const h of list) {
    assert.ok(["blocked", "disclosed"].includes(h.status));
    if (h.host.includes("*")) assert.equal(h.status, "disclosed");
  }
});

test("hosts in a page; a wildcard entry covers subdomains", () => {
  assert.deepEqual(hostsIn('<script src="https://www.googletagmanager.com/gtag/js"></script><a href="http://Example.ORG/x">'), ["example.org", "www.googletagmanager.com"]);
  assert.ok(listed("x.clarity.ms", list));
  assert.ok(!listed("clarity.ms.evil.example", list));
});

test("a new host opens a finding per host and scope, with the pin's version; every listed host closes on the list alone", () => {
  const obs = compare(["www.clarity.ms", "tracker.example"], "stable", list, "", "0.41.1");
  const found = obs.filter((o: any) => o.kind === "studio-hosts");
  assert.deepEqual(found.map((o: any) => [o.repo, o.channel, o.version]), [["tracker.example", "stable", "0.41.1"]]);
  assert.match(found[0].detail, /not proof of use/);
  const closed = obs.filter((o: any) => o.kind === "studio-hosts-ok").map((o: any) => o.repo);
  assert.ok(closed.includes("(extraction)"));
  // Recorded, even if this binary no longer names it.
  for (const h of list) assert.ok(closed.includes(h.host));
});

test("a failed extraction is its own finding, and recorded hosts still close", () => {
  const obs = compare(null, "default", list, "no index.html");
  assert.deepEqual(obs.filter((o: any) => o.kind === "studio-hosts").map((o: any) => o.repo), ["(extraction)"]);
  assert.equal(obs.filter((o: any) => o.kind === "studio-hosts-ok").length, list.length);
  assert.throws(() => embeddedAssets(Buffer.from("not an elf file at all"), () => true), /not a 64-bit/);
});
