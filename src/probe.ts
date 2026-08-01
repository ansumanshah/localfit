import type {
  Env,
  GpuAdapterInfo,
  MemoryInfo,
  PlatformInfo,
  WasmInfo,
  WebGpuInfo,
} from "./types.js";

// The canonical minimal SIMD-using WASM module, as used by
// GoogleChromeLabs/wasm-feature-detect. It is valid WASM iff the engine
// implements the SIMD proposal; WebAssembly.validate() either accepts or
// rejects it, no guessing involved.
const SIMD_TEST_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

let cached: Promise<Env> | null = null;

/**
 * Detects this browser's capabilities without downloading anything. Cached
 * per page load: call it as many times as you like, the actual detection
 * work (notably requestAdapter()) runs once.
 */
export function probe(): Promise<Env> {
  if (!cached) {
    cached = detect();
  }
  return cached;
}

/** Test-only: clears the per-page-load cache so tests can probe() with fresh mocked globals. */
export function __resetProbeCache(): void {
  cached = null;
}

async function detect(): Promise<Env> {
  const webgpu = await detectWebGpu();
  return {
    webgpu,
    wasm: detectWasm(),
    memory: detectMemory(),
    platform: detectPlatform(),
  };
}

async function detectWebGpu(): Promise<WebGpuInfo> {
  const unsupported: WebGpuInfo = {
    supported: false,
    shaderF16: null,
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    adapterInfo: null,
  };

  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    return unsupported;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return unsupported;

    const shaderF16 =
      typeof adapter.features?.has === "function" ? adapter.features.has("shader-f16") : null;
    const maxBufferSize = numberOrNull(adapter.limits?.maxBufferSize);
    const maxStorageBufferBindingSize = numberOrNull(adapter.limits?.maxStorageBufferBindingSize);
    const adapterInfo = await readAdapterInfo(adapter);

    return {
      supported: true,
      shaderF16,
      maxBufferSize,
      maxStorageBufferBindingSize,
      adapterInfo,
    };
  } catch {
    // requestAdapter() can reject in locked-down environments; treat as unsupported.
    return unsupported;
  }
}

async function readAdapterInfo(adapter: GPUAdapter): Promise<GpuAdapterInfo | null> {
  // Spec settled on adapter.info (a plain property); some older
  // implementations exposed an async requestAdapterInfo() instead. Try both,
  // guess neither.
  try {
    const info = (adapter as { info?: GPUAdapterInfo }).info;
    if (info) {
      return {
        vendor: stringOrNull(info.vendor),
        architecture: stringOrNull(info.architecture),
        device: stringOrNull(info.device),
        description: stringOrNull(info.description),
      };
    }
  } catch {
    // fall through to the legacy path
  }

  const legacy = (adapter as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> })
    .requestAdapterInfo;
  if (typeof legacy === "function") {
    try {
      const info = await legacy.call(adapter);
      return {
        vendor: stringOrNull(info.vendor),
        architecture: stringOrNull(info.architecture),
        device: stringOrNull(info.device),
        description: stringOrNull(info.description),
      };
    } catch {
      return null;
    }
  }

  return null;
}

function detectWasm(): WasmInfo {
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_TEST_MODULE);
  } catch {
    simd = false;
  }

  const threads =
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== "undefined";

  return { simd, threads };
}

function detectMemory(): MemoryInfo {
  const nav =
    typeof navigator !== "undefined" ? (navigator as NavigatorWithDeviceMemory) : undefined;
  const deviceMemoryGb = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;

  const perf =
    typeof performance !== "undefined" ? (performance as PerformanceWithMemory) : undefined;
  const jsHeapSizeLimitBytes =
    typeof perf?.memory?.jsHeapSizeLimit === "number" ? perf.memory.jsHeapSizeLimit : null;

  return { deviceMemoryGb, jsHeapSizeLimitBytes };
}

function detectPlatform(): PlatformInfo {
  if (typeof navigator === "undefined") {
    return { isIOS: false, isSecureContext: false };
  }

  const ua = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";
  const isClassicIOSUA = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports navigator.platform as "MacIntel" to pass desktop-site
  // checks; multi-touch is the reliable signal a real Mac never has.
  const isIPadOSAsMac = platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;
  const isIOS = isClassicIOSUA || isIPadOSAsMac;

  // isSecureContext is a bare global in both Window and Worker scopes (it
  // resolves via globalThis in either), so gating on `window` wrongly reports
  // false in Workers. The typeof guard only protects against environments
  // (e.g. SSR) where the identifier doesn't exist at all. Note: the local
  // binding is deliberately named differently from the global it reads --
  // `const isSecureContext = typeof isSecureContext !== "undefined" ...`
  // would shadow the global with a TDZ binding for the whole scope and throw
  // a ReferenceError on its own right-hand side.
  const secureContext = typeof isSecureContext !== "undefined" ? Boolean(isSecureContext) : false;

  return { isIOS, isSecureContext: secureContext };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: { jsHeapSizeLimit: number };
}
