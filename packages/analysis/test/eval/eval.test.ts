import { beforeAll, describe, expect, it } from "vitest";
import { centerOnReference, loadEmbedder } from "@reflex/embeddings";
import { sessionContext } from "../../src/context";
import { type EvalData, type EvalResult, evaluate, loadEvalData, vectorsFor } from "./harness";

/**
 * Request-matching quality on the labeled evaluation set (packages/test-fixtures/src/eval.ts).
 * Lexical numbers always run; numbers with the real model run when REFLEX_TEST_MODEL_DIR points at
 * an installed model (e.g. ~/.reflex/models/all-minilm-l6-v2-q8). REFLEX_EVAL_VERBOSE=1 prints the
 * task make-up of every suggestion.
 *
 * Before the changes these bounds protect (embedding the request after the file kinds, without
 * pasted logs, with the second request, centered on a reference mean; intent checked while merging),
 * the model gave intent AUC 0.876, cluster F1 0.608 and 5 clean suggestions; lexical alone 0.627 F1.
 */

let data: EvalData;
beforeAll(async () => {
  data = await loadEvalData();
});

function report(name: string, r: EvalResult): void {
  const { detail, ...nums } = r;
  console.log(`${name.padEnd(8)} ${JSON.stringify(nums)}`);
  if (process.env.REFLEX_EVAL_VERBOSE) for (const d of detail) console.log(`    ${d}`);
}

describe("evaluation set", () => {
  it("labels every session", () => {
    expect(data.traces.length).toBeGreaterThan(60);
    for (const t of data.traces) expect(() => data.taskOf(t.sessionId)).not.toThrow();
  });

  it("lexical matching", () => {
    const r = evaluate(data);
    report("lexical", r);
    expect(r.intentAuc).toBeGreaterThan(0.8);
    expect(r.clusterF1).toBeGreaterThan(0.65);
    expect(r.clean).toBeGreaterThanOrEqual(6);
  });
});

const modelDir = process.env.REFLEX_TEST_MODEL_DIR;

describe.skipIf(!modelDir)("evaluation set (real model)", () => {
  it("matching by meaning", async () => {
    const embedder = await loadEmbedder(modelDir!);
    const vectors = await vectorsFor(data, async (d) => (await embedder.embed(d)).map((v) => centerOnReference(v)), sessionContext);
    const r = evaluate(data, { vectors });
    report("model", r);
    expect(r.intentAuc).toBeGreaterThan(0.9);
    expect(r.clusterF1).toBeGreaterThan(0.69);
    expect(r.clean).toBeGreaterThanOrEqual(7);
    expect(r.impure).toBeLessThanOrEqual(3);
  });
});
