import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEmbedder } from "../src/embedder";
import { BGE_M3, MINILM, MODELS, modelDir, modelReads } from "../src/model";
import { centerOnReference, meanVector, referenceRequests } from "../src/reference";
import { REFERENCE_MEAN_BGE_M3, REFERENCE_MEAN_MINILM } from "../src/reference-mean";

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).reduce((s, x, i) => s + x * b[i]!, 0);

describe("reference centering", () => {
  it("removes the reference direction and keeps unit length", () => {
    const mean = Float32Array.from(REFERENCE_MEAN_MINILM);
    const v = Float32Array.from(mean, (x, k) => x + (k === 0 ? 0.5 : 0));
    const c = centerOnReference(v, MINILM);
    expect(dot(c, c)).toBeCloseTo(1, 5);
    // What remains is the part that differs from the reference: the first axis only.
    expect(c[0]).toBeCloseTo(1, 5);
  });

  it("leaves vectors of a model without a reference mean as they are", () => {
    const v = [0.6, 0.8];
    expect(Array.from(centerOnReference(v, { ...MINILM, id: "other-model" }))).toEqual([0.6000000238418579, 0.800000011920929]);
  });

  it("stores one mean value per dimension for every model", () => {
    expect(REFERENCE_MEAN_MINILM).toHaveLength(MINILM.dimensions);
    expect(REFERENCE_MEAN_BGE_M3).toHaveLength(BGE_M3.dimensions);
  });
});

// Needs the real model files (see embedder.test.ts).
const root = process.env.REFLEX_TEST_MODELS;
const means = { [MINILM.id]: REFERENCE_MEAN_MINILM, [BGE_M3.id]: REFERENCE_MEAN_BGE_M3 };

for (const model of MODELS) {
  describe.skipIf(!root || !existsSync(modelDir(root, model)))(`reference mean (${model.name})`, () => {
    it("matches the mean of the reference requests' vectors", async () => {
      const e = await loadEmbedder(modelDir(root!, model), model);
      const mean = meanVector(await e.embed(referenceRequests(model)));
      const pinned = means[model.id]!;
      for (let k = 0; k < mean.length; k++) expect(Math.abs(mean[k]! - pinned[k]!)).toBeLessThan(1e-4);
    }, 300_000);
  });
}

describe("what a model can read", () => {
  it("MiniLM reads English, code and mostly-English text with a few other letters", () => {
    expect(modelReads("make the login page load faster", MINILM)).toBe(true);
    expect(modelReads("TypeError at src/api/users.ts:42 — fix it", MINILM)).toBe(true);
    expect(modelReads("rename getUserById to findUser, see the café menu", MINILM)).toBe(true);
    expect(modelReads("1234 !!!", MINILM)).toBe(true);
  });

  it("MiniLM does not read Korean or other scripts its vocabulary lacks", () => {
    expect(modelReads("결제 페이지 로딩을 빠르게 해줘", MINILM)).toBe(false);
    expect(modelReads("README 먼저 읽고 결제 페이지 로딩을 빠르게 해줘", MINILM)).toBe(false);
    expect(modelReads("ログイン画面が遅い", MINILM)).toBe(false);
  });

  it("bge-m3 reads every script", () => {
    expect(modelReads("README 먼저 읽고 결제 페이지 로딩을 빠르게 해줘", BGE_M3)).toBe(true);
    expect(modelReads("ログイン画面が遅い", BGE_M3)).toBe(true);
  });
});
