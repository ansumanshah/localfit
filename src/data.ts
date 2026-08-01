import snapshotFile from "./data/snapshot.json" with { type: "json" };
import type { ModelInfo, Snapshot } from "./types.js";

// Ships later: localmodel.run's browser-models catalog exposed as a live
// endpoint. Until then, refresh() against this URL will 404 and silently
// keep the bundled snapshot, which is exactly the documented fallback
// behavior.
export const DATA_URL = "https://localmodel.run/api/browser-models.json";

let snapshot: Snapshot = snapshotFile as unknown as Snapshot;

/** All models in the current snapshot (bundled, or merged in by a prior refresh()). */
export function models(): ModelInfo[] {
  return snapshot.models;
}

/** A single model by id, or undefined if it is not in the snapshot. */
export function getModel(id: string): ModelInfo | undefined {
  return snapshot.models.find((m) => m.id === id);
}

/** Metadata about the currently loaded snapshot: when it was synced and from where. */
export function snapshotMeta(): Snapshot["meta"] {
  return snapshot.meta;
}

/**
 * Fetches a newer dataset and merges it into the snapshot by id (fetched
 * entries win). On any fetch failure, non-OK response, JSON parse error, or
 * shape mismatch, this silently keeps the current snapshot: a bad refresh
 * must never leave the package in a broken state.
 */
export async function refresh(url: string = DATA_URL): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) return;

    const data: unknown = await res.json();
    const incoming = extractValidModels(data);
    if (incoming.length === 0) return;

    const byId = new Map(snapshot.models.map((m) => [m.id, m]));
    for (const model of incoming) byId.set(model.id, model);

    snapshot = {
      meta: {
        ...snapshot.meta,
        syncedAt: new Date().toISOString(),
      },
      models: Array.from(byId.values()),
    };
  } catch {
    // Network error, JSON parse error, or anything else: keep what we have.
  }
}

/** Test-only: restores the bundled snapshot after a test calls refresh(). */
export function __resetSnapshot(): void {
  snapshot = snapshotFile as unknown as Snapshot;
}

function extractValidModels(data: unknown): ModelInfo[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.models)
      ? data.models
      : null;
  if (!list) return [];
  return list.filter(isValidModelInfo);
}

function isValidModelInfo(value: unknown): value is ModelInfo {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.hf_repo !== "string") return false;
  if (!isRecord(value.headline)) return false;
  if (!isValidHeadline(value.headline.webgpu) || !isValidHeadline(value.headline.wasm))
    return false;
  if (!isRecord(value.variants)) return false;
  return true;
}

function isValidHeadline(value: unknown): boolean {
  return isRecord(value) && typeof value.variant === "string" && typeof value.bytes === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
