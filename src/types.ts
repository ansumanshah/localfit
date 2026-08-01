// Every field this package cannot verify is explicitly null. Nothing here is
// ever guessed or estimated from a heuristic; see probe.ts and fit.ts for
// where each field comes from.

/** Adapter info exposed by a WebGPU adapter, where the browser reports it. */
export interface GpuAdapterInfo {
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
}

export interface WebGpuInfo {
  /** navigator.gpu is present AND requestAdapter() resolved to a non-null adapter. */
  supported: boolean;
  /** null when WebGPU itself is unsupported: shader-f16 can't be checked without an adapter. */
  shaderF16: boolean | null;
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  adapterInfo: GpuAdapterInfo | null;
}

export interface WasmInfo {
  /** WebAssembly.validate() against a minimal SIMD module. Always determinable. */
  simd: boolean;
  /** crossOriginIsolated && SharedArrayBuffer available. Always determinable. */
  threads: boolean;
}

export interface MemoryInfo {
  /**
   * navigator.deviceMemory, in GB. Chromium-only; null everywhere else. Per
   * spec, values are bucketized (0.25, 0.5, 1, 2, 4, 8) and capped at 8 for
   * fingerprinting resistance: a reported 8 means "8 GB or more", not
   * necessarily exactly 8.
   */
  deviceMemoryGb: number | null;
  /** performance.memory.jsHeapSizeLimit, in bytes. Chromium-only; null everywhere else. */
  jsHeapSizeLimitBytes: number | null;
}

export interface PlatformInfo {
  /** True for iPhone/iPad UAs, and for iPadOS 13+ reporting itself as a Mac (touch-point heuristic). */
  isIOS: boolean;
  isSecureContext: boolean;
}

export interface Env {
  webgpu: WebGpuInfo;
  wasm: WasmInfo;
  memory: MemoryInfo;
  platform: PlatformInfo;
}

export type Verdict = "yes" | "tight" | "no" | "unknown";

export type RuntimeName = "transformers.js" | "wllama" | "webllm";

export interface FitOptions {
  env?: Env;
  runtime?: RuntimeName;
  /**
   * Score a specific variant from the model's measured `variants` table
   * instead of the chosen backend's headline pick. For callers that have
   * verified the headline build is broken at runtime and load a different
   * one (e.g. Kokoro's q4f16 is audibly degraded over WebGPU, so the page
   * loads fp32). The bytes still come from the measured catalog, never from
   * the caller. Naming the headline variant itself is a no-op (the default
   * plan, including the shader-f16 auto-swap); a name that is not in the
   * table keeps the headline behavior and says so in `reasons`.
   */
  variant?: string;
}

export interface FitPlan {
  verdict: Verdict;
  backend: "webgpu" | "wasm";
  dtype: string;
  downloadBytes: number;
  /** The model's HuggingFace repo id, e.g. "onnx-community/gemma-3-1b-it-ONNX". */
  model: string;
  /** One honest sentence per decision made while building this plan. Never empty. */
  reasons: string[];
  /** Ready to spread into the chosen runtime's load call. Shape varies by runtime; see README. */
  config: Record<string, unknown>;
}

export interface ModelSource {
  label: string;
  url: string;
}

export interface ModelVariantHeadline {
  variant: string;
  bytes: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  hf_repo: string;
  task: string;
  params_m: number | null;
  headline: {
    webgpu: ModelVariantHeadline;
    wasm: ModelVariantHeadline;
  };
  variants: Record<string, number>;
  pipeline_task: string | null;
  // Stripped from the bundled snapshot to keep consumer bundles small; the
  // primary source for any entry is always https://huggingface.co/<hf_repo>.
  // Rows merged in via refresh() from the live catalog carry all three.
  sources?: ModelSource[];
  notes?: string;
  code_snippet?: string;
}

export interface SnapshotMeta {
  syncedAt: string;
  source: {
    repo: string;
    path: string;
    branch: string | null;
    commit: string | null;
  };
}

export interface Snapshot {
  meta: SnapshotMeta;
  models: ModelInfo[];
}
