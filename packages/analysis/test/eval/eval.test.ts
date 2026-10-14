import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BGE_M3, MINILM, type ModelSpec, centerOnReference, loadEmbedder, modelDir, modelReads } from "@reflex/embeddings";
import { EVAL_SESSIONS, EVAL_SESSIONS_KO } from "@reflex/test-fixtures";
import { sessionContext, withFloor } from "../../src/context";
import { type EvalData, type EvalResult, evaluate, loadEvalData } from "./harness";

/**
 * Request-matching quality on the labeled evaluation sets (packages/test-fixtures/src/eval.ts, and
 * eval-ko.ts for Korean). Lexical numbers always run; numbers with a real model run for each model
 * found in REFLEX_TEST_MODELS (a models folder, e.g. ~/.reflex/models). REFLEX_EVAL_VERBOSE=1
 * prints the task make-up of every suggestion.
 *
 * Before the context and clustering changes these bounds protect, MiniLM gave intent AUC 0.876,
 * cluster F1 0.608 and 5 clean suggestions on the English set; lexical alone 0.627 F1.
 */

let en: EvalData;
let mixed: EvalData;
beforeAll(async () => {
  en = await loadEvalData();
  mixed = await loadEvalData([...EVAL_SESSIONS, ...EVAL_SESSIONS_KO]);
});

function report(name: string, r: EvalResult): void {
  const { detail, ...nums } = r;
  console.log(`${name.padEnd(16)} ${JSON.stringify(nums)}`);
  if (process.env.REFLEX_EVAL_VERBOSE) for (const d of detail) console.log(`    ${d}`);
}

/** Vectors as the CLI builds them: context documents, text the model cannot read left out, centered, with the model's floor. */
async function vectorsOf(data: EvalData, model: ModelSpec, dir: string) {
  const embedder = await loadEmbedder(dir, model);
  const docs = data.sessions.map((s, i) => sessionContext(s, data.traces[i]!));
  const keep = docs.map((d) => modelReads(d.replace(/^Files: [^\n]*\n/, ""), model));
  const v = await embedder.embed(docs.filter((_, i) => keep[i]));
  let k = 0;
  const vectors = new Map(data.traces.flatMap((t, i) => (keep[i] ? [[t.sessionId, centerOnReference(v[k++]!, model)] as const] : [])));
  return withFloor(vectors, model.floor);
}

describe("evaluation set", () => {
  it("labels every session", () => {
    expect(en.traces.length).toBeGreaterThan(60);
    for (const t of mixed.traces) expect(() => mixed.taskOf(t.sessionId)).not.toThrow();
  });

  it("lexical matching", () => {
    const r = evaluate(en);
    report("lexical EN", r);
    report("lexical EN+KO", evaluate(mixed));
    expect(r.intentAuc).toBeGreaterThan(0.8);
    expect(r.clusterF1).toBeGreaterThan(0.65);
    expect(r.clean).toBeGreaterThanOrEqual(6);
  });
});

const root = process.env.REFLEX_TEST_MODELS;
const available = (m: ModelSpec) => !!root && existsSync(modelDir(root, m));

describe.skipIf(!available(MINILM))("evaluation set (MiniLM)", () => {
  it("matching by meaning", async () => {
    const r = evaluate(en, { vectors: await vectorsOf(en, MINILM, modelDir(root!, MINILM)) });
    report("minilm EN", r);
    report("minilm EN+KO", evaluate(mixed, { vectors: await vectorsOf(mixed, MINILM, modelDir(root!, MINILM)) }));
    expect(r.intentAuc).toBeGreaterThan(0.9);
    expect(r.clusterF1).toBeGreaterThan(0.69);
    expect(r.clean).toBeGreaterThanOrEqual(7);
    expect(r.impure).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!available(BGE_M3))("evaluation set (bge-m3)", () => {
  it("matching by meaning, in English and across English and Korean", async () => {
    const e = evaluate(en, { vectors: await vectorsOf(en, BGE_M3, modelDir(root!, BGE_M3)) });
    const m = evaluate(mixed, { vectors: await vectorsOf(mixed, BGE_M3, modelDir(root!, BGE_M3)) });
    report("bge-m3 EN", e);
    report("bge-m3 EN+KO", m);
    expect(e.intentAuc).toBeGreaterThan(0.89);
    expect(e.clusterF1).toBeGreaterThan(0.69);
    expect(e.clean).toBeGreaterThanOrEqual(7);
    expect(m.intentAuc).toBeGreaterThan(0.9);
    expect(m.clusterF1).toBeGreaterThan(0.72);
    expect(m.clean).toBeGreaterThanOrEqual(8);
    expect(m.impure).toBeLessThanOrEqual(3);
  }, 600_000);
});
