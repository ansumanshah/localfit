#!/usr/bin/env bun
// Refreshes the bundled browser-models snapshot and stamps it with a sync
// date plus the exact source commit it came from. The source of truth is
// the localmodel.run repository (github.com/ansumanshah/localmodel.run);
// this script never modifies the source, only src/data/snapshot.json here.
//
// Usage:
//   bun scripts/sync-data.ts                       # fetch from GitHub (default)
//   bun scripts/sync-data.ts /path/to/checkout     # copy from a local checkout
//   LOCALFIT_SOURCE_REPO=/path bun scripts/sync-data.ts

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_REPO = "ansumanshah/localmodel.run";
const SOURCE_PATH = "src/data/browser-models.json";

const localSource = process.argv[2] ?? process.env.LOCALFIT_SOURCE_REPO ?? null;

let models: unknown;
let branch: string | null = null;
let commit: string | null = null;

if (localSource) {
  const sourceDataPath = resolve(localSource, SOURCE_PATH);
  if (!existsSync(sourceDataPath)) {
    console.error(`Source data not found at ${sourceDataPath}`);
    process.exit(1);
  }
  models = JSON.parse(readFileSync(sourceDataPath, "utf-8"));
  const git = (cmd: string): string | null => {
    try {
      return execSync(cmd, { cwd: localSource, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  branch = git("git rev-parse --abbrev-ref HEAD");
  commit = git("git rev-parse HEAD");
} else {
  branch = "main";
  const commitRes = await fetch(`https://api.github.com/repos/${SOURCE_REPO}/commits/main`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!commitRes.ok) {
    console.error(`Could not resolve ${SOURCE_REPO} main commit (HTTP ${commitRes.status})`);
    process.exit(1);
  }
  commit = ((await commitRes.json()) as { sha: string }).sha;
  const dataRes = await fetch(
    `https://raw.githubusercontent.com/${SOURCE_REPO}/${commit}/${SOURCE_PATH}`,
  );
  if (!dataRes.ok) {
    console.error(`Could not fetch ${SOURCE_PATH} at ${commit} (HTTP ${dataRes.status})`);
    process.exit(1);
  }
  models = await dataRes.json();
}

if (!Array.isArray(models)) {
  console.error(`Expected an array of models, got ${typeof models}`);
  process.exit(1);
}

// Strip catalog fields the library never reads (sources, notes,
// code_snippet: ~34% of the raw snapshot). They stay available via the live
// API and refresh(); the primary source for any entry remains derivable as
// https://huggingface.co/<hf_repo>.
const BUNDLE_EXCLUDED_FIELDS = ["sources", "notes", "code_snippet"] as const;
models = models.map((row) => {
  const slim = { ...(row as Record<string, unknown>) };
  for (const field of BUNDLE_EXCLUDED_FIELDS) delete slim[field];
  return slim;
});

const snapshot = {
  meta: {
    syncedAt: new Date().toISOString(),
    source: {
      repo: "localmodel.run",
      path: SOURCE_PATH,
      branch,
      commit,
    },
  },
  models,
};

const outPath = resolve(import.meta.dir, "../src/data/snapshot.json");
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Synced ${models.length} models from ${localSource ?? `${SOURCE_REPO}@${commit}`}`);
console.log(`Wrote ${outPath}`);
