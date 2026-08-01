import { describe, expect, test } from "bun:test";
import { models, snapshotMeta } from "../src/data.js";

describe("snapshot integrity", () => {
  const all = models();

  test("the snapshot is non-empty", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  test("every model has a webgpu headline and a wasm headline (no undocumented gaps)", () => {
    for (const model of all) {
      expect(model.headline.webgpu, `${model.id} missing webgpu headline`).toBeDefined();
      expect(model.headline.wasm, `${model.id} missing wasm headline`).toBeDefined();
      expect(typeof model.headline.webgpu.variant).toBe("string");
      expect(typeof model.headline.wasm.variant).toBe("string");
      expect(model.headline.webgpu.bytes).toBeGreaterThan(0);
      expect(model.headline.wasm.bytes).toBeGreaterThan(0);
    }
  });

  test("every headline variant is present in that model's variants table, with matching bytes", () => {
    for (const model of all) {
      for (const headline of [model.headline.webgpu, model.headline.wasm]) {
        const bytes = model.variants[headline.variant];
        expect(bytes, `${model.id}: headline variant "${headline.variant}" not in variants{}`).toBe(
          headline.bytes,
        );
      }
    }
  });

  test("every model has a non-empty hf_repo (the provenance pointer)", () => {
    for (const model of all) {
      expect(typeof model.hf_repo).toBe("string");
      expect(model.hf_repo.length, `${model.id} has no hf_repo`).toBeGreaterThan(0);
    }
  });

  test("bundle-excluded catalog fields are stripped from the snapshot", () => {
    for (const model of all) {
      expect(model.sources, `${model.id} still carries sources`).toBeUndefined();
      expect(model.notes, `${model.id} still carries notes`).toBeUndefined();
      expect(model.code_snippet, `${model.id} still carries code_snippet`).toBeUndefined();
    }
  });

  test("ids are unique", () => {
    const ids = new Set(all.map((m) => m.id));
    expect(ids.size).toBe(all.length);
  });

  test("snapshot metadata records where and when it was synced", () => {
    const meta = snapshotMeta();
    expect(typeof meta.syncedAt).toBe("string");
    expect(new Date(meta.syncedAt).toString()).not.toBe("Invalid Date");
    expect(meta.source.repo).toBe("localmodel.run");
    expect(typeof meta.source.path).toBe("string");
  });
});
