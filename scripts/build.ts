#!/usr/bin/env bun
// bun's bundler treats `"sideEffects": false` in the nearest package.json as
// license to drop anything it thinks is unused, including (confirmed on bun
// 1.3.14) the entry point's OWN re-exported bindings: `bun build src/index.ts`
// with sideEffects:false present produced an 88-byte stub exporting names
// with no declarations behind them. `sideEffects: false` needs to ship in
// package.json (it is a real, correct hint for consumers' bundlers) but must
// not be present while WE build the entry point. So: strip it, build, put it
// back, always, even on failure.
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgPath = `${root}/package.json`;
const original = await Bun.file(pkgPath).text();
const pkg = JSON.parse(original) as Record<string, unknown>;

if (!("sideEffects" in pkg)) {
  console.error(
    `FATAL: "sideEffects" is missing from ${pkgPath}.\n` +
      "A previously interrupted build (killed mid-run, before the finally-restore) likely " +
      'dropped it. Restore it by hand before building: add `"sideEffects": false` back to ' +
      "package.json, then re-run this script.",
  );
  process.exit(1);
}

if (existsSync(`${root}/dist`)) rmSync(`${root}/dist`, { recursive: true, force: true });

let buildFailed = false;
try {
  delete pkg.sideEffects;
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await $`bun build src/index.ts --outdir dist --format esm --target browser`.cwd(root);
} catch (err) {
  buildFailed = true;
  console.error(err);
} finally {
  await Bun.write(pkgPath, original);
}

if (buildFailed) process.exit(1);

await $`tsc -p tsconfig.build.json`.cwd(root);
