import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetProbeCache, probe } from "../src/probe.js";

const realNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const realPerformanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
const realCrossOriginIsolatedDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);
const realIsSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "isSecureContext",
);

function setNavigator(nav: Partial<Navigator> & Record<string, unknown>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });
}

function setCrossOriginIsolated(value: boolean | undefined): void {
  if (value === undefined) {
    // Simulate the global being entirely absent (most real browsers, outside
    // a cross-origin-isolated top-level document).
    delete (globalThis as Record<string, unknown>).crossOriginIsolated;
    return;
  }
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value,
    configurable: true,
    writable: true,
  });
}

function setIsSecureContext(value: boolean | undefined): void {
  if (value === undefined) {
    // Simulate the global being entirely absent (e.g. an SSR environment
    // with no window/worker scope at all).
    delete (globalThis as Record<string, unknown>).isSecureContext;
    return;
  }
  Object.defineProperty(globalThis, "isSecureContext", {
    value,
    configurable: true,
    writable: true,
  });
}

function setPerformanceMemory(memory: { jsHeapSizeLimit: number } | undefined): void {
  const perf = globalThis.performance as unknown as { memory?: unknown };
  if (memory === undefined) {
    delete perf.memory;
  } else {
    perf.memory = memory;
  }
}

beforeEach(() => {
  __resetProbeCache();
});

afterEach(() => {
  __resetProbeCache();
  if (realNavigatorDescriptor)
    Object.defineProperty(globalThis, "navigator", realNavigatorDescriptor);
  if (realPerformanceDescriptor) {
    Object.defineProperty(globalThis, "performance", realPerformanceDescriptor);
  }
  if (realCrossOriginIsolatedDescriptor) {
    Object.defineProperty(globalThis, "crossOriginIsolated", realCrossOriginIsolatedDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).crossOriginIsolated;
  }
  if (realIsSecureContextDescriptor) {
    Object.defineProperty(globalThis, "isSecureContext", realIsSecureContextDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).isSecureContext;
  }
});

describe("probe: WebGPU", () => {
  test("reports unsupported when navigator.gpu is absent", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    const env = await probe();
    expect(env.webgpu.supported).toBe(false);
    expect(env.webgpu.shaderF16).toBeNull();
    expect(env.webgpu.maxBufferSize).toBeNull();
  });

  test("reports unsupported when requestAdapter() resolves to null", async () => {
    setNavigator({
      userAgent: "test-agent",
      platform: "Win32",
      maxTouchPoints: 0,
      gpu: { requestAdapter: async () => null },
    });
    const env = await probe();
    expect(env.webgpu.supported).toBe(false);
  });

  test("reports full capabilities from a mocked adapter", async () => {
    setNavigator({
      userAgent: "test-agent",
      platform: "Win32",
      maxTouchPoints: 0,
      gpu: {
        requestAdapter: async () => ({
          features: { has: (name: string) => name === "shader-f16" },
          limits: { maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 },
          info: {
            vendor: "acme",
            architecture: "test-arch",
            device: "test-device",
            description: "",
          },
        }),
      },
    });
    const env = await probe();
    expect(env.webgpu.supported).toBe(true);
    expect(env.webgpu.shaderF16).toBe(true);
    expect(env.webgpu.maxBufferSize).toBe(268435456);
    expect(env.webgpu.adapterInfo?.vendor).toBe("acme");
    expect(env.webgpu.adapterInfo?.description).toBeNull(); // empty string -> null, never guessed
  });

  test("caches the result: requestAdapter() is called at most once per probe cache lifetime", async () => {
    let calls = 0;
    setNavigator({
      userAgent: "test-agent",
      platform: "Win32",
      maxTouchPoints: 0,
      gpu: {
        requestAdapter: async () => {
          calls += 1;
          return null;
        },
      },
    });
    await probe();
    await probe();
    await probe();
    expect(calls).toBe(1);
  });
});

describe("probe: WASM", () => {
  test("SIMD support is always determinable (never null)", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    const env = await probe();
    expect(typeof env.wasm.simd).toBe("boolean");
  });

  test("threads require both crossOriginIsolated and SharedArrayBuffer", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    setCrossOriginIsolated(false);
    let env = await probe();
    expect(env.wasm.threads).toBe(false);

    __resetProbeCache();
    setCrossOriginIsolated(true);
    env = await probe();
    expect(env.wasm.threads).toBe(typeof SharedArrayBuffer !== "undefined");
  });
});

describe("probe: memory", () => {
  test("null when neither signal is available", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    setPerformanceMemory(undefined);
    const env = await probe();
    expect(env.memory.deviceMemoryGb).toBeNull();
    expect(env.memory.jsHeapSizeLimitBytes).toBeNull();
  });

  test("reads navigator.deviceMemory and performance.memory.jsHeapSizeLimit when present", async () => {
    setNavigator({
      userAgent: "test-agent",
      platform: "Win32",
      maxTouchPoints: 0,
      deviceMemory: 8,
    });
    setPerformanceMemory({ jsHeapSizeLimit: 4294967296 });
    const env = await probe();
    expect(env.memory.deviceMemoryGb).toBe(8);
    expect(env.memory.jsHeapSizeLimitBytes).toBe(4294967296);
  });
});

describe("probe: platform (iOS detection)", () => {
  test("detects a classic iPhone user agent", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const env = await probe();
    expect(env.platform.isIOS).toBe(true);
  });

  test("detects iPadOS 13+ reporting itself as a Mac via the touch-point quirk", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6)",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const env = await probe();
    expect(env.platform.isIOS).toBe(true);
  });

  test("a real Mac (MacIntel, no touch) is not misdetected as iOS", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    const env = await probe();
    expect(env.platform.isIOS).toBe(false);
  });
});

describe("probe: platform (isSecureContext)", () => {
  test("reads the bare global in a worker-like scope (no `window`)", async () => {
    // Workers have no `window`; isSecureContext is a bare global there
    // instead (WorkerGlobalScope.isSecureContext), same as in a Window. This
    // repo's test runtime already has no `window` global, standing in for a
    // worker scope.
    expect(typeof (globalThis as Record<string, unknown>).window).toBe("undefined");
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    setIsSecureContext(true);
    const env = await probe();
    expect(env.platform.isSecureContext).toBe(true);
  });

  test("reads false from the bare global when insecure", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    setIsSecureContext(false);
    const env = await probe();
    expect(env.platform.isSecureContext).toBe(false);
  });

  test("defaults to false when isSecureContext is undeclared anywhere", async () => {
    setNavigator({ userAgent: "test-agent", platform: "Win32", maxTouchPoints: 0 });
    setIsSecureContext(undefined);
    const env = await probe();
    expect(env.platform.isSecureContext).toBe(false);
  });
});
