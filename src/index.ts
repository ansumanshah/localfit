export { DATA_URL, getModel, models, refresh, snapshotMeta } from "./data.js";
export { fit } from "./fit.js";
export { probe } from "./probe.js";
// NOTE: scripts/build.ts strips "sideEffects": false from package.json before
// building this entry point and restores it afterward. bun's bundler treats
// sideEffects:false as license to drop unused bindings, and (confirmed on bun
// 1.3.14) that included this entry point's OWN re-exported bindings when the
// flag was present during the build. sideEffects:false is a real, correct
// hint for consumers' bundlers, so it stays in the shipped package.json; it
// just must not be present while we build.
export type {
  Env,
  FitOptions,
  FitPlan,
  GpuAdapterInfo,
  MemoryInfo,
  ModelInfo,
  ModelSource,
  ModelVariantHeadline,
  PlatformInfo,
  RuntimeName,
  Snapshot,
  SnapshotMeta,
  Verdict,
  WasmInfo,
  WebGpuInfo,
} from "./types.js";
