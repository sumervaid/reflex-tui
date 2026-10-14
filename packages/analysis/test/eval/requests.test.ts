import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { MODELS, type ModelSpec, centerOnReference, loadEmbedder, modelDir, modelReads } from "@reflex/embeddings";
import { CONFUSABLE, LABELED_REQUESTS as R } from "@reflex/test-fixtures";
import { intentSimilarities } from "../../src/cluster";
import { dotProduct } from "../../src/context";
import { intentTerms } from "../../src/intents";

/**
 * Request-level benchmark on LABELED_REQUESTS (14 tasks, 7 languages): do two requests ask for the
 * same kind of task? Word matching per language always runs; each model found in
 * REFLEX_TEST_MODELS is scored by its cosine alone, per language pairing.
 */

const LANGS = [...new Set(R.map((r) => r.lang))];

function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
const r3 = (x: number) => (Number.isNaN(x) ? "n/a" : x.toFixed(3));

/** AUC over pairs selected by `keep`, scored by `sim`. */
function pairAuc(sim: (i: number, j: number) => number | undefined, keep: (i: number, j: number) => boolean): number {
  const same: number[] = [];
  const diff: number[] = [];
  for (let i = 0; i < R.length; i++)
    for (let j = i + 1; j < R.length; j++) {
      if (!keep(i, j)) continue;
      const s = sim(i, j);
      if (s === undefined) continue;
      (R[i]!.task === R[j]!.task ? same : diff).push(s);
    }
  return auc(same, diff);
}

const confusable = (i: number, j: number) =>
  R[i]!.task === R[j]!.task ? CONFUSABLE.some(([a, b]) => R[i]!.task === a || R[i]!.task === b) : CONFUSABLE.some(([a, b]) => (R[i]!.task === a && R[j]!.task === b) || (R[i]!.task === b && R[j]!.task === a));

export function lexicalScores() {
  const traces = R.map((r, i) => ({ sessionId: `r${i}`, intents: intentTerms(r.text) }) as WorkflowTrace);
  const sim = intentSimilarities(traces);
  const perLang = Object.fromEntries(LANGS.map((l) => [l, pairAuc(sim, (i, j) => R[i]!.lang === l && R[j]!.lang === l)]));
  return { perLang, sameLanguage: pairAuc(sim, (i, j) => R[i]!.lang === R[j]!.lang), confusable: pairAuc(sim, (i, j) => R[i]!.lang === R[j]!.lang && confusable(i, j)) };
}

describe("request benchmark: word matching", () => {
  it("scores each language", () => {
    const s = lexicalScores();
    console.log(`words   same-language=${r3(s.sameLanguage)} confusable=${r3(s.confusable)} | ${LANGS.map((l) => `${l}=${r3(s.perLang[l]!)}`).join(" ")}`);
    expect(s.perLang.en).toBeGreaterThan(0.75);
  });
});

const root = process.env.REFLEX_TEST_MODELS;
const available = (m: ModelSpec) => !!root && existsSync(modelDir(root, m));

for (const model of MODELS) {
  describe.skipIf(!available(model))(`request benchmark: ${model.name}`, () => {
    it("scores the model's cosine per language pairing", async () => {
      const e = await loadEmbedder(modelDir(root!, model), model);
      const keep = R.map((r) => modelReads(r.text, model));
      const raw = await e.embed(R.filter((_, i) => keep[i]).map((r) => r.text));
      let k = 0;
      const v = keep.map((x) => (x ? centerOnReference(raw[k++]!, model) : undefined));
      const sim = (i: number, j: number) => (v[i] && v[j] ? dotProduct(v[i]!, v[j]!) : undefined);
      const en = (i: number) => R[i]!.lang === "en";
      const s = {
        all: pairAuc(sim, () => true),
        enEn: pairAuc(sim, (i, j) => en(i) && en(j)),
        sameOther: pairAuc(sim, (i, j) => !en(i) && R[i]!.lang === R[j]!.lang),
        cross: pairAuc(sim, (i, j) => R[i]!.lang !== R[j]!.lang),
        confusable: pairAuc(sim, confusable),
      };
      const coverage = keep.filter(Boolean).length / R.length;
      console.log(
        `${model.name.padEnd(7)} coverage=${(coverage * 100).toFixed(0)}% all=${r3(s.all)} en-en=${r3(s.enEn)} same-other=${r3(s.sameOther)} cross=${r3(s.cross)} confusable=${r3(s.confusable)}`,
      );
      expect(s.enEn).toBeGreaterThan(0.8);
      if (model.reads === "all") expect(s.cross).toBeGreaterThan(0.8);
    }, 600_000);
  });
}
