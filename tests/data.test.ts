import { afterEach, describe, expect, test } from "bun:test";
import { __resetSnapshot, getModel, models, refresh } from "../src/data.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetSnapshot();
});

describe("data: models() / getModel()", () => {
  test("models() returns the bundled snapshot", () => {
    const all = models();
    expect(all.length).toBeGreaterThan(0);
  });

  test("getModel() finds a known id and returns undefined for an unknown one", () => {
    const known = models()[0]!;
    expect(getModel(known.id)?.id).toBe(known.id);
    expect(getModel("not-a-real-model-id")).toBeUndefined();
  });
});

describe("data: refresh() failure modes silently keep the snapshot", () => {
  test("network error", async () => {
    const before = models();
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(models()).toEqual(before);
  });

  test("non-OK response", async () => {
    const before = models();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not found", { status: 404 }))) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(models()).toEqual(before);
  });

  test("malformed JSON", async () => {
    const before = models();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("{not json", { status: 200 }))) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(models()).toEqual(before);
  });

  test("well-formed JSON with the wrong shape", async () => {
    const before = models();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
      )) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(models()).toEqual(before);
  });

  test("an array of entries missing required fields", async () => {
    const before = models();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([{ id: "incomplete-model" }]), { status: 200 }),
      )) as typeof fetch;
    await refresh("https://example.invalid/models.json");
    expect(models()).toEqual(before);
    expect(getModel("incomplete-model")).toBeUndefined();
  });
});

describe("data: refresh() merges valid entries by id", () => {
  test("a new, valid model id is added", async () => {
    const before = models().length;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: "fixture-new-model",
              name: "Fixture New Model",
              hf_repo: "fixture/new-model",
              task: "text-generation",
              params_m: 1,
              headline: {
                webgpu: { variant: "q4f16", bytes: 1000 },
                wasm: { variant: "uint8", bytes: 2000 },
              },
              variants: { q4f16: 1000, uint8: 2000 },
              pipeline_task: "text-generation",
              sources: [],
            },
          ]),
          { status: 200 },
        ),
      )) as typeof fetch;

    await refresh("https://example.invalid/models.json");

    expect(models().length).toBe(before + 1);
    expect(getModel("fixture-new-model")?.hf_repo).toBe("fixture/new-model");
  });

  test("an existing id is overwritten by the fetched entry", async () => {
    const existing = models()[0]!;
    const patchedName = `${existing.name} (patched)`;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([{ ...existing, name: patchedName }]), { status: 200 }),
      )) as typeof fetch;

    await refresh("https://example.invalid/models.json");

    expect(getModel(existing.id)?.name).toBe(patchedName);
  });
});
