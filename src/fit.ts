import { getModel } from "./data.js";
import { probe } from "./probe.js";
import type { Env, FitOptions, FitPlan, ModelInfo, RuntimeName } from "./types.js";

const MEMORY_TIGHT_FRACTION = 0.6;

/**
 * Picks a backend, quant variant, and runtime config for `modelId` against
 * the given (or freshly probed) browser Env. Never claims a speed number.
 * Every verdict carries at least one honest reason.
 */
export async function fit(modelId: string, opts: FitOptions = {}): Promise<FitPlan> {
  const model = getModel(modelId);
  if (!model) {
    return {
      verdict: "unknown",
      backend: "wasm",
      dtype: "",
      downloadBytes: 0,
      model: modelId,
      reasons: [`Unknown model id "${modelId}": not present in the bundled data snapshot.`],
      config: {},
    };
  }

  const env = opts.env ?? (await probe());
  const reasons: string[] = [];

  const backendPlan = resolveBackend(env, opts.runtime);
  if (backendPlan.hardNo) {
    reasons.push(backendPlan.reason);
    const headline = model.headline.webgpu;
    return {
      verdict: "no",
      backend: backendPlan.backend,
      dtype: headline.variant,
      downloadBytes: headline.bytes,
      model: model.hf_repo,
      reasons,
      config: buildConfig(opts.runtime, backendPlan.backend, headline.variant),
    };
  }

  const backend = backendPlan.backend;
  const headline = backend === "webgpu" ? model.headline.webgpu : model.headline.wasm;
  if (!headline) {
    reasons.push(`No ${backend} build is published for this model.`);
    return {
      verdict: "no",
      backend,
      dtype: "",
      downloadBytes: 0,
      model: model.hf_repo,
      reasons,
      config: {},
    };
  }

  let variant = headline.variant;
  let bytes = headline.bytes;

  if (backend === "webgpu") {
    if (env.webgpu.shaderF16 === false && isF16Variant(variant)) {
      // Choosing the smallest non-f16 variant here is an untested assumption:
      // q8/uint8 builds are conventionally WASM-oriented, not verified as the
      // best WebGPU fallback. Revisit once the data model tags which variants
      // are actually meant for WebGPU vs WASM.
      const alt = smallestNonF16Variant(model.variants);
      if (alt) {
        reasons.push(
          `This adapter has no shader-f16 support, so ${variant} was swapped for ${alt.variant} (${formatBytes(alt.bytes)}).`,
        );
        variant = alt.variant;
        bytes = alt.bytes;
      } else {
        reasons.push(
          `This adapter has no shader-f16 support and no non-f16 variant is published, so the ${variant} headline build was kept; its WebGPU shaders may fail to compile.`,
        );
      }
    } else if (env.webgpu.shaderF16 === null && isF16Variant(variant)) {
      reasons.push(
        `shader-f16 support could not be determined (no WebGPU adapter available); the ${variant} headline variant, which needs it, was kept anyway.`,
      );
    }
  }

  // Informational only, not a verdict change: maxBufferSize is a per-buffer
  // limit, but runtimes allocate weights across many per-tensor buffers, not
  // one buffer for the whole download. A total download bigger than
  // maxBufferSize does not by itself mean the model can't load.
  if (
    backend === "webgpu" &&
    env.webgpu.maxBufferSize != null &&
    bytes > env.webgpu.maxBufferSize
  ) {
    reasons.push(
      `Total download exceeds this adapter's per-buffer limit (maxBufferSize: ${formatBytes(env.webgpu.maxBufferSize)}). Weights load as many smaller buffers, so this alone does not block loading.`,
    );
  }

  const memorySignal = pickMemorySignal(env);
  let verdict: FitPlan["verdict"];
  if (memorySignal == null) {
    verdict = "unknown";
    reasons.push(
      "No memory signal is available (navigator.deviceMemory and performance.memory are both unsupported here), so fit against available RAM cannot be judged.",
    );
  } else {
    const signalLabel =
      memorySignal.source === "jsHeapSizeLimit"
        ? "the per-tab JS heap limit (performance.memory.jsHeapSizeLimit)"
        : "navigator.deviceMemory (capped at 8 GB by spec)";
    if (bytes > memorySignal.bytes * MEMORY_TIGHT_FRACTION) {
      verdict = "tight";
      const capNote = memorySignal.deviceMemoryAtCap
        ? " This device reported the spec's 8 GB cap, so its actual memory may be higher than this estimate assumes."
        : "";
      reasons.push(
        `The ${formatBytes(bytes)} download is more than ${Math.round(MEMORY_TIGHT_FRACTION * 100)}% of ${signalLabel} (${formatBytes(memorySignal.bytes)}); it may load slowly or fail on constrained devices.${capNote}`,
      );
    } else {
      verdict = "yes";
      reasons.push(
        `The ${formatBytes(bytes)} download fits within ${signalLabel} (${formatBytes(memorySignal.bytes)}).`,
      );
    }
  }

  return {
    verdict,
    backend,
    dtype: variant,
    downloadBytes: bytes,
    model: model.hf_repo,
    reasons,
    config: buildConfig(opts.runtime, backend, variant),
  };
}

interface BackendResolution {
  backend: "webgpu" | "wasm";
  hardNo: boolean;
  reason: string;
}

function resolveBackend(env: Env, runtime: RuntimeName | undefined): BackendResolution {
  if (runtime === "webllm") {
    // WebLLM (MLC) only runs over WebGPU; there is no WASM fallback path.
    if (!env.webgpu.supported) {
      return {
        backend: "webgpu",
        hardNo: true,
        reason: "webllm requires WebGPU, and this browser's WebGPU support is unavailable.",
      };
    }
    return { backend: "webgpu", hardNo: false, reason: "" };
  }

  if (runtime === "wllama") {
    // wllama is a WASM build of llama.cpp; it never touches WebGPU.
    return { backend: "wasm", hardNo: false, reason: "" };
  }

  // transformers.js, or no runtime specified: prefer WebGPU when usable.
  return { backend: env.webgpu.supported ? "webgpu" : "wasm", hardNo: false, reason: "" };
}

function isF16Variant(variant: string): boolean {
  return variant === "fp16" || variant.includes("f16");
}

function smallestNonF16Variant(
  variants: Record<string, number>,
): { variant: string; bytes: number } | null {
  let best: { variant: string; bytes: number } | null = null;
  for (const [variant, bytes] of Object.entries(variants)) {
    if (isF16Variant(variant)) continue;
    if (!best || bytes < best.bytes) best = { variant, bytes };
  }
  return best;
}

interface MemorySignal {
  bytes: number;
  source: "jsHeapSizeLimit" | "deviceMemory";
  /** True when the signal is navigator.deviceMemory and it reported exactly 8, the spec's cap. */
  deviceMemoryAtCap: boolean;
}

function pickMemorySignal(env: Env): MemorySignal | null {
  // jsHeapSizeLimit is the more direct signal (the actual ceiling for this
  // tab); deviceMemory is a coarse, capped, device-wide bucket. Prefer the
  // more precise one when both are present.
  if (env.memory.jsHeapSizeLimitBytes != null) {
    return {
      bytes: env.memory.jsHeapSizeLimitBytes,
      source: "jsHeapSizeLimit",
      deviceMemoryAtCap: false,
    };
  }
  if (env.memory.deviceMemoryGb != null) {
    return {
      bytes: env.memory.deviceMemoryGb * 1024 ** 3,
      source: "deviceMemory",
      deviceMemoryAtCap: env.memory.deviceMemoryGb === 8,
    };
  }
  return null;
}

function buildConfig(
  runtime: RuntimeName | undefined,
  backend: "webgpu" | "wasm",
  dtype: string,
): Record<string, unknown> {
  if (runtime === "wllama") {
    // wllama has no device/dtype concept the way transformers.js does: it is
    // always WASM, and its "variant" is which GGUF file to fetch. Only the
    // backend is meaningful here; wiring the exact wllama load options is
    // left to the caller until that shape is verified against a real
    // integration.
    return { backend };
  }
  if (runtime === "webllm") {
    // WebLLM selects models from its own MLC registry / a model record, not
    // a bare {device, dtype} pair. Same caveat as wllama above.
    return { backend };
  }
  // transformers.js (default): the one shape this package guarantees.
  return { device: backend, dtype };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export type { ModelInfo };
