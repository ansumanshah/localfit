import { afterEach, describe, expect, test } from "bun:test";
import { fit } from "../src/fit.js";
import { __resetSnapshot, getModel, refresh } from "../src/data.js";
import { makeEnv, noWebGpuEnv } from "./helpers.js";

// Fixture: a small text model with both a q4f16 WebGPU headline and a uint8
// WASM headline, and a q4f16-free set of alternative variants. Picked
// because its numbers are stable in the bundled snapshot and cheap to
// hand-verify against src/data/snapshot.json.
const MODEL_ID = "smollm2-135m-instruct";

describe("fit: backend selection", () => {
  test("picks wasm when WebGPU is unsupported", async () => {
    const plan = await fit(MODEL_ID, { env: noWebGpuEnv() });
    expect(plan.backend).toBe("wasm");
    const model = getModel(MODEL_ID)!;
    expect(plan.dtype).toBe(model.headline.wasm.variant);
    expect(plan.downloadBytes).toBe(model.headline.wasm.bytes);
  });

  test("picks webgpu when it is usable", async () => {
    const plan = await fit(MODEL_ID, { env: makeEnv() });
    expect(plan.backend).toBe("webgpu");
    const model = getModel(MODEL_ID)!;
    expect(plan.dtype).toBe(model.headline.webgpu.variant);
  });

  test("wllama always resolves to wasm, even when WebGPU is available", async () => {
    const plan = await fit(MODEL_ID, { env: makeEnv(), runtime: "wllama" });
    expect(plan.backend).toBe("wasm");
  });
});

describe("fit: shader-f16 avoidance", () => {
  test("swaps an f16 WebGPU variant for the smallest non-f16 alternative when shader-f16 is absent", async () => {
    const model = getModel(MODEL_ID)!;
    expect(model.headline.webgpu.variant).toBe("q4f16"); // sanity: fixture assumption holds

    const plan = await fit(MODEL_ID, {
      env: makeEnv({ webgpu: { shaderF16: false } }),
    });

    expect(plan.backend).toBe("webgpu");
    expect(plan.dtype).not.toContain("f16");

    const nonF16Variants = Object.entries(model.variants).filter(([name]) => !name.includes("f16"));
    const smallest = nonF16Variants.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(plan.dtype).toBe(smallest[0]);
    expect(plan.downloadBytes).toBe(smallest[1]);
    expect(plan.reasons.some((r) => r.includes("shader-f16"))).toBe(true);
  });

  test("keeps the f16 headline variant, with a reason, when shader-f16 support is unknown", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ webgpu: { supported: true, shaderF16: null } }),
    });
    const model = getModel(MODEL_ID)!;
    expect(plan.dtype).toBe(model.headline.webgpu.variant);
    expect(plan.reasons.some((r) => r.toLowerCase().includes("could not be determined"))).toBe(
      true,
    );
  });

  test("does not touch WASM dtype selection (shader-f16 is a WebGPU-only concern)", async () => {
    const plan = await fit(MODEL_ID, {
      env: noWebGpuEnv(),
    });
    const model = getModel(MODEL_ID)!;
    expect(plan.dtype).toBe(model.headline.wasm.variant);
  });
});

describe("fit: verdict 'no'", () => {
  test("webllm with no WebGPU support is a hard no", async () => {
    const plan = await fit(MODEL_ID, { env: noWebGpuEnv(), runtime: "webllm" });
    expect(plan.verdict).toBe("no");
    expect(plan.reasons.some((r) => r.includes("webllm requires WebGPU"))).toBe(true);
  });
});

describe("fit: maxBufferSize is informational, not a verdict gate", () => {
  test("a download bigger than the adapter's maxBufferSize is NOT a hard no: it's a per-buffer limit, and weights load as many smaller buffers", async () => {
    const model = getModel(MODEL_ID)!;
    const plan = await fit(MODEL_ID, {
      env: makeEnv({
        webgpu: { maxBufferSize: model.headline.webgpu.bytes - 1 },
      }),
    });
    expect(plan.verdict).not.toBe("no");
    expect(
      plan.reasons.some((r) => r.includes("maxBufferSize") && r.includes("does not block loading")),
    ).toBe(true);
  });

  test("no reason mentions maxBufferSize when the download is within it", async () => {
    const model = getModel(MODEL_ID)!;
    const plan = await fit(MODEL_ID, {
      env: makeEnv({
        webgpu: { maxBufferSize: model.headline.webgpu.bytes + 1 },
      }),
    });
    expect(plan.reasons.some((r) => r.includes("maxBufferSize"))).toBe(false);
  });
});

describe("fit: verdict 'unknown'", () => {
  test("unknown model id", async () => {
    const plan = await fit("this-model-does-not-exist", { env: makeEnv() });
    expect(plan.verdict).toBe("unknown");
    expect(plan.reasons.some((r) => r.includes("this-model-does-not-exist"))).toBe(true);
  });

  test("no memory signal available at all", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ memory: { deviceMemoryGb: null, jsHeapSizeLimitBytes: null } }),
    });
    expect(plan.verdict).toBe("unknown");
    expect(plan.reasons.some((r) => r.toLowerCase().includes("no memory signal"))).toBe(true);
  });
});

describe("fit: verdict 'tight' and 'yes'", () => {
  test("tight when the download exceeds 60% of the available memory signal", async () => {
    const model = getModel(MODEL_ID)!;
    const bytes = model.headline.webgpu.bytes;
    const plan = await fit(MODEL_ID, {
      env: makeEnv({
        memory: { jsHeapSizeLimitBytes: Math.floor(bytes / 0.61), deviceMemoryGb: null },
      }),
    });
    expect(plan.verdict).toBe("tight");
  });

  test("yes when the download comfortably fits available memory", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ memory: { jsHeapSizeLimitBytes: 16 * 1024 ** 3 } }),
    });
    expect(plan.verdict).toBe("yes");
  });
});

describe("fit: memory-signal reason naming", () => {
  test("names performance.memory.jsHeapSizeLimit when that signal is used", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ memory: { jsHeapSizeLimitBytes: 16 * 1024 ** 3, deviceMemoryGb: null } }),
    });
    expect(plan.reasons.some((r) => r.includes("performance.memory.jsHeapSizeLimit"))).toBe(true);
  });

  test("names navigator.deviceMemory (and its 8 GB cap) when that signal is used", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ memory: { jsHeapSizeLimitBytes: null, deviceMemoryGb: 8 } }),
    });
    expect(plan.reasons.some((r) => r.includes("navigator.deviceMemory"))).toBe(true);
    expect(plan.reasons.some((r) => r.includes("capped at 8 GB by spec"))).toBe(true);
  });

  test("does not mention the 8 GB cap when deviceMemory reports a bucket below the cap", async () => {
    const plan = await fit(MODEL_ID, {
      env: makeEnv({ memory: { jsHeapSizeLimitBytes: null, deviceMemoryGb: 4 } }),
    });
    expect(plan.reasons.some((r) => r.includes("its actual memory may be higher"))).toBe(false);
  });
});

describe("fit: 'tight' verdict built on a capped deviceMemory reading", () => {
  const BIG_MODEL_ID = "fixture-big-model";

  afterEach(() => {
    __resetSnapshot();
  });

  test("notes that actual memory may be higher than the capped 8 GB reading implies", async () => {
    // No real catalog entry is big enough to exceed 60% of 8 GB (max webgpu
    // headline in the bundled snapshot is ~4.37 GB), so inject a fixture
    // model via refresh() to exercise this path for real, the same pattern
    // tests/data.test.ts uses for refresh() fixtures.
    const bigBytes = 6 * 1024 ** 3; // 6 GB: > 60% of the 8 GB deviceMemory cap
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: BIG_MODEL_ID,
              name: "Fixture Big Model",
              hf_repo: "fixture/big-model",
              task: "text-generation",
              params_m: 7000,
              headline: {
                webgpu: { variant: "q4f16", bytes: bigBytes },
                wasm: { variant: "uint8", bytes: bigBytes },
              },
              variants: { q4f16: bigBytes, uint8: bigBytes },
              pipeline_task: "text-generation",
              sources: [{ label: "fixture", url: "https://example.invalid" }],
            },
          ]),
          { status: 200 },
        ),
      )) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(getModel(BIG_MODEL_ID)).toBeDefined();

    const plan = await fit(BIG_MODEL_ID, {
      env: makeEnv({ memory: { jsHeapSizeLimitBytes: null, deviceMemoryGb: 8 } }),
    });

    expect(plan.verdict).toBe("tight");
    expect(
      plan.reasons.some(
        (r) => r.includes("navigator.deviceMemory") && r.includes("actual memory may be higher"),
      ),
    ).toBe(true);
  });
});

describe("fit: config shape", () => {
  test("transformers.js gets a {device, dtype} config", async () => {
    const plan = await fit(MODEL_ID, { env: makeEnv(), runtime: "transformers.js" });
    expect(plan.config).toEqual({ device: plan.backend, dtype: plan.dtype });
  });

  test("no config ever claims a speed number", async () => {
    const plan = await fit(MODEL_ID, { env: makeEnv() });
    const serialized = JSON.stringify(plan);
    expect(serialized.toLowerCase()).not.toContain("tok/s");
    expect(serialized.toLowerCase()).not.toContain("tokens/sec");
  });
});
