// Write a repository's pin by hand: the first pins, and hand re-pins through
// branch CI. The updater (update.ts) writes them afterwards, with the same
// verifier.
//
//   node scripts/pin.ts REPO [TAG]      (TAG: default the highest eligible)
//   node scripts/pin.ts --all
import { join } from "node:path";
import { fromRest, RECENT, select, sourceOf, SOURCES, versionOf, type Source } from "../shared/sources.ts";
import { buildPin } from "./lib/pins.ts";
import { currentPin, Failed, getJson, getPages, VERSIONS, writeJson } from "./lib/util.ts";

const usage = "usage: node scripts/pin.ts REPO [TAG] | --all";

async function pinOne(source: Source, tag: string | null): Promise<void> {
  let release;
  if (tag) {
    if (!versionOf(source, tag)) throw new Failed(`${tag} doesn't match ${source.repo}'s tags (${source.tags})`);
    release = fromRest(await getJson(`https://api.github.com/repos/storytold/${source.repo}/releases/tags/${encodeURIComponent(tag)}`));
  } else {
    const { items } = await getPages(`https://api.github.com/repos/storytold/${source.repo}/releases?per_page=${RECENT}`);
    release = select(source, items.map(fromRest)).candidate;
    if (!release) throw new Failed(`${source.repo}: no eligible release`);
  }
  const pin = await buildPin(source, release, currentPin(source.repo));
  writeJson(join(VERSIONS, `${source.repo}.json`), pin);
  console.log(`${source.repo} ${pin.version}: ${Object.keys(pin.packages).join(", ")}`);
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "--all" && argv.length === 1) {
    let failed = 0;
    for (const s of SOURCES) {
      try {
        await pinOne(s, null);
      } catch (e: any) {
        failed++;
        console.error(`pin: ${s.repo}: ${e instanceof Failed ? e.message : e.stack ?? e}`);
      }
    }
    if (failed) process.exit(1);
    return;
  }
  if (argv.length < 1 || argv.length > 2 || argv[0].startsWith("-")) throw new Failed(usage);
  await pinOne(sourceOf(argv[0]), argv[1] ?? null);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`pin: ${e instanceof Failed ? e.message : e.stack ?? e}`);
  process.exit(1);
});
