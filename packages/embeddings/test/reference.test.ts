import { describe, expect, it } from "vitest";
import { loadEmbedder } from "../src/embedder";
import { MODEL, modelReads } from "../src/model";
import { REFERENCE_REQUESTS, centerOnReference, meanVector } from "../src/reference";
import { REFERENCE_MEAN_MINILM } from "../src/reference-mean";

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).reduce((s, x, i) => s + x * b[i]!, 0);

describe("reference centering", () => {
  it("removes the reference direction and keeps unit length", () => {
    const mean = Float32Array.from(REFERENCE_MEAN_MINILM);
    const v = Float32Array.from(mean, (x, k) => x + (k === 0 ? 0.5 : 0));
    const c = centerOnReference(v);
    expect(dot(c, c)).toBeCloseTo(1, 5);
    // What remains is the part that differs from the reference: the first axis only.
    expect(c[0]).toBeCloseTo(1, 5);
  });

  it("leaves vectors of other models as they are", () => {
    const v = [0.6, 0.8];
    expect(Array.from(centerOnReference(v, "other-model"))).toEqual([0.6000000238418579, 0.800000011920929]);
  });

  it("stores one mean value per dimension", () => {
    expect(REFERENCE_MEAN_MINILM).toHaveLength(MODEL.dimensions);
  });
});

// Needs the real model files (see embedder.test.ts).
const dir = process.env.REFLEX_TEST_MODEL_DIR;

describe.skipIf(!dir)("reference mean (real model)", () => {
  it("matches the mean of the reference requests' vectors", async () => {
    const e = await loadEmbedder(dir!);
    const mean = meanVector(await e.embed(REFERENCE_REQUESTS));
    for (let k = 0; k < mean.length; k++) expect(Math.abs(mean[k]! - REFERENCE_MEAN_MINILM[k]!)).toBeLessThan(1e-4);
  });
});

describe("what the model can read", () => {
  it("reads English, code and mostly-English text with a few other letters", () => {
    expect(modelReads("make the login page load faster")).toBe(true);
    expect(modelReads("TypeError at src/api/users.ts:42 — fix it")).toBe(true);
    expect(modelReads("rename getUserById to findUser, see the café menu")).toBe(true);
    expect(modelReads("1234 !!!")).toBe(true);
  });

  it("does not read Korean or other scripts its vocabulary lacks", () => {
    expect(modelReads("결제 페이지 로딩을 빠르게 해줘")).toBe(false);
    expect(modelReads("README 먼저 읽고 결제 페이지 로딩을 빠르게 해줘")).toBe(false);
    expect(modelReads("ログイン画面が遅い")).toBe(false);
  });
});
