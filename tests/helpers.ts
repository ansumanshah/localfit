import type { Env } from "../src/types.js";

type EnvOverrides = {
  webgpu?: Partial<Env["webgpu"]>;
  wasm?: Partial<Env["wasm"]>;
  memory?: Partial<Env["memory"]>;
  platform?: Partial<Env["platform"]>;
};

/** A fully-capable Env (WebGPU + shader-f16, threaded WASM, generous memory) to start from. */
export function makeEnv(overrides: EnvOverrides = {}): Env {
  return {
    webgpu: {
      supported: true,
      shaderF16: true,
      maxBufferSize: 2 ** 31,
      maxStorageBufferBindingSize: 2 ** 30,
      adapterInfo: null,
      ...overrides.webgpu,
    },
    wasm: {
      simd: true,
      threads: true,
      ...overrides.wasm,
    },
    memory: {
      deviceMemoryGb: 8,
      jsHeapSizeLimitBytes: 4 * 1024 ** 3,
      ...overrides.memory,
    },
    platform: {
      isIOS: false,
      isSecureContext: true,
      ...overrides.platform,
    },
  };
}

/** An Env with no WebGPU at all: navigator.gpu absent or requestAdapter() returned null. */
export function noWebGpuEnv(overrides: EnvOverrides = {}): Env {
  return makeEnv({
    ...overrides,
    webgpu: {
      supported: false,
      shaderF16: null,
      maxBufferSize: null,
      maxStorageBufferBindingSize: null,
      adapterInfo: null,
      ...overrides.webgpu,
    },
  });
}
