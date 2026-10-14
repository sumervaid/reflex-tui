import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import { MODELS, embeddingThreads, loadEmbedder, modelByName, modelDir } from "@reflex/embeddings";
import { LABELED_REQUESTS } from "@reflex/test-fixtures";
import { contextDocument } from "../../src/context";

/**
 * How fast and how heavy each model is on this machine, with synthetic requests only (no one's
 * history). Run per model in its own process, since peak memory is per process and the WebAssembly
 * thread count is fixed once the runtime starts:
 *
 *   REFLEX_PERF=bge-m3 REFLEX_TEST_MODELS=~/.reflex/models pnpm vitest run packages/analysis/test/eval/perf.test.ts
 *
 * REFLEX_EMBED_THREADS sets the threads. REFLEX_PERF_OUT writes the result as JSON; in GitHub
 * Actions the result is also added to the job summary.
 */

const name = process.env.REFLEX_PERF;
const root = process.env.REFLEX_TEST_MODELS;
const model = name ? modelByName(name) : undefined;
const ready = !!model && !!root && existsSync(modelDir(root, model));

/** Requests as people type them (short), and long ones near what the adapters keep (2,000 characters). */
function inputs(): { short: string[]; long: string[] } {
  const short = LABELED_REQUESTS.filter((_, i) => i % 8 === 0).map((r) => contextDocument({ excerpt: "", fileCategories: ["source"] }, r.text));
  const long: string[] = [];
  for (const lang of ["en", "ko", "ja", "zh", "es", "de", "fr"]) {
    const texts = LABELED_REQUESTS.filter((r) => r.lang === lang).map((r) => r.text);
    let doc = "";
    for (let i = 0; doc.length < 2000; i++) doc += `${texts[i % texts.length]}. `;
    long.push(contextDocument({ excerpt: "", fileCategories: ["source", "tests"] }, doc));
  }
  return { short, long };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.skipIf(!ready)(`performance: ${name}`, () => {
  it("measures load time, time per request and peak memory", async () => {
    const threads = embeddingThreads();
    const t0 = performance.now();
    const e = await loadEmbedder(modelDir(root!, model!), model!);
    const loadMs = performance.now() - t0;
    const { short, long } = inputs();
    const time = async (docs: string[]) => {
      const ms: number[] = [];
      for (const d of docs) {
        const s = performance.now();
        await e.embed([d]);
        ms.push(performance.now() - s);
      }
      return Math.round(median(ms));
    };
    await e.embed(["warm up"]);
    const result = {
      model: model!.name,
      platform: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model.trim() ?? "unknown",
      cores: availableParallelism(),
      memoryGB: Math.round(totalmem() / 1e9),
      threads,
      loadMs: Math.round(loadMs),
      shortRequestMs: await time(short),
      longRequestMs: await time(long),
      // maxRSS is in kilobytes.
      peakMemoryMB: Math.round(process.resourceUsage().maxRSS / 1024),
    };
    console.log(`PERF ${JSON.stringify(result)}`);
    if (process.env.REFLEX_PERF_OUT) writeFileSync(process.env.REFLEX_PERF_OUT, JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `| ${result.platform} | ${result.cpu} | ${result.model} | ${result.threads} | ${result.loadMs} ms | ${result.shortRequestMs} ms | ${result.longRequestMs} ms | ${result.peakMemoryMB} MB |\n`,
      );
    expect(result.peakMemoryMB).toBeGreaterThan(0);
    expect(MODELS).toContain(model);
  }, 1_800_000);
});
