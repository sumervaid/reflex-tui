import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEmbedder } from "../src/embedder";
import { BGE_M3, MINILM, type ModelSpec, modelDir } from "../src/model";
import { centerOnReference } from "../src/reference";

// Needs the real model files: set REFLEX_TEST_MODELS to a models folder holding them
// (for example ~/.reflex/models after `reflex model fetch`). Each model runs only if present.
const root = process.env.REFLEX_TEST_MODELS;
const dirOf = (m: ModelSpec) => (root && existsSync(modelDir(root, m)) ? modelDir(root, m) : undefined);
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe.skipIf(!dirOf(MINILM))("embedder (MiniLM)", () => {
  it("matches the reference similarity for this model", async () => {
    const e = await loadEmbedder(dirOf(MINILM)!, MINILM);
    const [a, b] = await e.embed(["A man is eating food.", "A man is eating a piece of bread."]);
    expect(a).toHaveLength(384);
    expect(dot(a!, a!)).toBeCloseTo(1, 4);
    expect(dot(a!, b!)).toBeCloseTo(0.757, 2);
  });

  it("embeds a text the same way regardless of what it is embedded with", async () => {
    const e = await loadEmbedder(dirOf(MINILM)!, MINILM);
    const [alone] = await e.embed(["the sign-in screen is really slow"]);
    const [, withOthers] = await e.embed(["a much longer request about something else entirely, with many more words", "the sign-in screen is really slow"]);
    expect(Array.from(withOthers!)).toEqual(Array.from(alone!));
  });

  it("connects paraphrases that share no words", async () => {
    const e = await loadEmbedder(dirOf(MINILM)!, MINILM);
    const [fast, slow, rename] = await e.embed(["make the login page load faster", "the sign-in screen is really slow", "rename getUserById to findUser"]);
    expect(dot(fast!, slow!)).toBeGreaterThan(dot(fast!, rename!) + 0.2);
  });
});

describe.skipIf(!dirOf(BGE_M3))("embedder (bge-m3)", () => {
  it("gives unit vectors of the model's size, the same alone or with others", async () => {
    const e = await loadEmbedder(dirOf(BGE_M3)!, BGE_M3);
    const [a] = await e.embed(["fix the failing CI on main"]);
    const [, b] = await e.embed(["something unrelated and much longer than the other text", "fix the failing CI on main"]);
    expect(a).toHaveLength(1024);
    expect(dot(a!, a!)).toBeCloseTo(1, 4);
    expect(Array.from(b!)).toEqual(Array.from(a!));
  });

  it("matches the same task across languages and in mixed-language requests", async () => {
    const e = await loadEmbedder(dirOf(BGE_M3)!, BGE_M3);
    const [en, ko, mixed, other] = await e.embed([
      "the checkout page loads too slowly, make it faster",
      "결제 페이지 로딩이 너무 느려, 빠르게 해줘",
      "checkout 페이지 로딩 speed 좀 개선해줘",
      "rename getUserById to findUser everywhere",
    ]);
    expect(dot(en!, ko!)).toBeGreaterThan(dot(en!, other!) + 0.15);
    expect(dot(ko!, mixed!)).toBeGreaterThan(dot(ko!, other!) + 0.15);
  });

  it("matches the docs' example in every language they show, after centering", async () => {
    const e = await loadEmbedder(dirOf(BGE_M3)!, BGE_M3);
    const texts = [
      "the sign-in screen is really slow",
      "로그인 화면이 너무 느려",
      "ログイン画面がすごく遅い",
      "登录页面加载太慢了",
      "la pantalla de inicio de sesión va muy lenta",
      "rename getUserById to findUser",
      "다크 모드 추가해줘",
      "把依赖升级到最新版本",
    ];
    const [en, ...rest] = (await e.embed(texts)).map((v) => centerOnReference(v, BGE_M3));
    const same = rest.slice(0, 4).map((v) => dot(en!, v));
    const unrelated = rest.slice(4).map((v) => dot(en!, v));
    for (const s of same) expect(s).toBeGreaterThan(Math.max(...unrelated) + 0.3);
  });
});
