import { mkdir, mkdtemp, readdir, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BGE_M3,
  DEFAULT_MODEL,
  MINILM,
  MODELS,
  type Fetcher,
  type ModelSpec,
  activeModel,
  fetchModel,
  modelByName,
  modelDir,
  modelStatus,
  modelVerified,
  readVerified,
  removeModel,
  setActiveModel,
  sha256Hex,
} from "../src/model";

const root = () => mkdtemp(join(tmpdir(), "reflex-models-"));
const serve = (body: Uint8Array, status = 200): Fetcher => async () => ({ ok: status === 200, status, arrayBuffer: async () => body.slice().buffer });

/** A model whose pinned files are small byte strings, so downloads can be exercised end to end. */
function tinyModel(files: Record<string, Uint8Array>): ModelSpec {
  return {
    ...MINILM,
    id: "tiny",
    name: "tiny",
    files: Object.entries(files).map(([name, data]) => ({ name, url: `https://example.test/${name}`, bytes: data.length, sha256: sha256Hex(data) })),
  };
}
const streaming = (files: Record<string, Uint8Array>): Fetcher => async (url) => {
  const data = files[url.split("/").pop()!]!;
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (let i = 0; i < data.length; i += 3) yield data.slice(i, i + 3);
    })(),
    arrayBuffer: async () => {
      throw new Error("should stream");
    },
  };
};

describe("model files", () => {
  it("pins every file of every model to a revision and a checksum", () => {
    for (const m of MODELS)
      for (const f of m.files) {
        expect(f.url).toMatch(/^https:\/\/huggingface\.co\/Xenova\/[\w.-]+\/resolve\/[0-9a-f]{40}\//);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
  });

  it("defaults to bge-m3 and offers MiniLM as the light model", () => {
    expect(DEFAULT_MODEL).toBe(BGE_M3);
    expect(modelByName("minilm")).toBe(MINILM);
    expect(() => modelByName("gpt")).toThrow(/bge-m3, minilm/);
  });

  it("reports a missing model", async () => {
    const r = await root();
    expect((await modelStatus(r, MINILM)).installed).toBe(false);
    expect(await activeModel(r)).toBeUndefined();
  });

  it("streams a download to disk and keeps it once it matches", async () => {
    const r = await root();
    const files = { "a.bin": new TextEncoder().encode("hello model"), "b.txt": new TextEncoder().encode("vocab") };
    const m = tinyModel(files);
    await fetchModel(r, m, streaming(files));
    expect((await readdir(modelDir(r, m))).sort()).toEqual(["a.bin", "b.txt"]);
    expect(await modelVerified(r, m)).toBe(true);
  });

  it("keeps nothing when a download does not match its checksum", async () => {
    const r = await root();
    const tampered = new Uint8Array(MINILM.files[0]!.bytes);
    await expect(fetchModel(r, MINILM, serve(tampered))).rejects.toThrow(/checksum/);
    expect(await readdir(modelDir(r, MINILM))).toEqual([]);
  });

  it("stops a download that grows past the pinned size", async () => {
    const r = await root();
    const m = tinyModel({ "a.bin": new Uint8Array(4) });
    await expect(fetchModel(r, m, streaming({ "a.bin": new Uint8Array(10) }))).rejects.toThrow(/larger/);
    expect(await readdir(modelDir(r, m))).toEqual([]);
  });

  it("stops on an HTTP error", async () => {
    const r = await root();
    await expect(fetchModel(r, MINILM, serve(new Uint8Array(), 404))).rejects.toThrow(/HTTP 404/);
  });

  it("refuses to load a file that was changed after download", async () => {
    const r = await root();
    await mkdir(modelDir(r, MINILM), { recursive: true });
    await writeFile(join(modelDir(r, MINILM), "vocab.txt"), "not the pinned vocabulary");
    await expect(readVerified(modelDir(r, MINILM), "vocab.txt", MINILM)).rejects.toThrow(/pinned/);
    expect(await modelVerified(r, MINILM)).toBe(false);
  });

  it("uses the chosen model, else whichever is installed, the default first", async () => {
    const r = await root();
    // Presence is checked by size only, so sparse files of the pinned sizes count as installed.
    const install = async (m: ModelSpec) => {
      await mkdir(modelDir(r, m), { recursive: true });
      for (const f of m.files) await truncate(join(modelDir(r, m), f.name), f.bytes).catch(async () => {
        await writeFile(join(modelDir(r, m), f.name), "");
        await truncate(join(modelDir(r, m), f.name), f.bytes);
      });
    };
    await install(MINILM);
    expect(await activeModel(r)).toBe(MINILM);
    await setActiveModel(r, BGE_M3);
    expect(await activeModel(r)).toBe(MINILM); // chosen but not installed
    await install(BGE_M3);
    expect(await activeModel(r)).toBe(BGE_M3);
    await setActiveModel(r, MINILM);
    expect(await activeModel(r)).toBe(MINILM);
  });

  it("removes a model directory", async () => {
    const r = await root();
    await mkdir(modelDir(r, MINILM), { recursive: true });
    expect(await removeModel(r, MINILM)).toBe(true);
    expect(await removeModel(r, MINILM)).toBe(false);
  });
});
