#!/usr/bin/env bun
// Measures the gzip size of the decision-logic bundle (probe + fit + data
// plumbing), with the bundled data snapshot swapped for an empty stub. The
// snapshot is content, not code, and will grow as the catalog grows; the
// <5KB budget applies to the logic that decides fit, not the table it looks
// models up in.
//
// Two footguns, both worked around the same way (write, subprocess build,
// restore in finally):
//  1. bun's bundler treats "sideEffects": false in package.json as license
//     to drop the entry point's own exports (see scripts/build.ts for the
//     full story). Must be absent from package.json while building.
//  2. In-process Bun.build() caches package.json at process startup, so
//     patching it mid-process (as an earlier version of this script did)
//     silently has no effect. Building via a real subprocess (bun's shell
//     helper, not the JS build API) re-reads it fresh, so that's what this
//     script does, exactly like scripts/build.ts.

import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const LIMIT_BYTES = 5 * 1024;

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgPath = `${root}/package.json`;
const snapshotPath = `${root}/src/data/snapshot.json`;

const originalPkgText = await Bun.file(pkgPath).text();
const originalSnapshotText = await Bun.file(snapshotPath).text();

if (!("sideEffects" in (JSON.parse(originalPkgText) as Record<string, unknown>))) {
  console.error(
    `FATAL: "sideEffects" is missing from ${pkgPath}.\n` +
      "A previously interrupted build (killed mid-run, before the finally-restore) likely " +
      'dropped it. Restore it by hand before building: add `"sideEffects": false` back to ' +
      "package.json, then re-run this script.",
  );
  process.exit(1);
}

const stubSnapshot = {
  meta: { syncedAt: "", source: { repo: "", path: "", branch: null, commit: null } },
  models: [],
};

const outDir = mkdtempSync(join(tmpdir(), "localfit-size-check-"));

let buildFailed = false;
try {
  const pkg = JSON.parse(originalPkgText) as Record<string, unknown>;
  delete pkg.sideEffects;
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  await Bun.write(snapshotPath, `${JSON.stringify(stubSnapshot, null, 2)}\n`);

  await $`bun build src/index.ts --outdir ${outDir} --format esm --target browser --minify`.cwd(
    root,
  );
} catch (err) {
  buildFailed = true;
  console.error(err);
} finally {
  await Bun.write(pkgPath, originalPkgText);
  await Bun.write(snapshotPath, originalSnapshotText);
}

if (buildFailed) {
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const code = await Bun.file(join(outDir, "index.js")).text();
rmSync(outDir, { recursive: true, force: true });

const raw = Buffer.byteLength(code, "utf-8");
const gzipped = gzipSync(Buffer.from(code, "utf-8"), { level: 9 });

console.log("Core bundle (data snapshot stubbed to isolate decision-logic weight):");
console.log(`  raw:    ${raw} bytes`);
console.log(`  gzip:   ${gzipped.length} bytes`);
console.log(`  budget: ${LIMIT_BYTES} bytes (min+gzip)`);

if (gzipped.length > LIMIT_BYTES) {
  console.error(
    `FAIL: core exceeds its ${LIMIT_BYTES}-byte gzip budget by ${gzipped.length - LIMIT_BYTES} bytes.`,
  );
  process.exit(1);
}

console.log(`OK: ${LIMIT_BYTES - gzipped.length} bytes under budget.`);
