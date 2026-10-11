import { describe, expect, it } from "vitest";
import { loadEmbedder } from "../src/embedder";

// Needs the real model files: set REFLEX_TEST_MODEL_DIR to a directory holding them
// (for example ~/.reflex/models/all-minilm-l6-v2-q8 after `reflex model fetch`).
const dir = process.env.REFLEX_TEST_MODEL_DIR;
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe.skipIf(!dir)("embedder (real model)", () => {
  it("matches the reference similarity for this model", async () => {
    const e = await loadEmbedder(dir!);
    const [a, b] = await e.embed(["A man is eating food.", "A man is eating a piece of bread."]);
    expect(a).toHaveLength(384);
    expect(dot(a!, a!)).toBeCloseTo(1, 4);
    expect(dot(a!, b!)).toBeCloseTo(0.757, 2);
  });

  it("embeds a text the same way regardless of what it is embedded with", async () => {
    const e = await loadEmbedder(dir!);
    const [alone] = await e.embed(["the sign-in screen is really slow"]);
    const [, withOthers] = await e.embed(["a much longer request about something else entirely, with many more words", "the sign-in screen is really slow"]);
    expect(Array.from(withOthers!)).toEqual(Array.from(alone!));
  });

  it("connects paraphrases that share no words", async () => {
    const e = await loadEmbedder(dir!);
    const [fast, slow, rename] = await e.embed(["make the login page load faster", "the sign-in screen is really slow", "rename getUserById to findUser"]);
    expect(dot(fast!, slow!)).toBeGreaterThan(dot(fast!, rename!) + 0.2);
  });
});
