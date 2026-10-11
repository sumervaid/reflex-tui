import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL, type Fetcher, fetchModel, modelDir, modelStatus, modelVerified, readVerified, removeModel } from "../src/model";

const root = () => mkdtemp(join(tmpdir(), "reflex-models-"));
const serve = (body: Uint8Array, status = 200): Fetcher => async () => ({ ok: status === 200, status, arrayBuffer: async () => body.slice().buffer });

describe("model files", () => {
  it("pins every file to a revision and a checksum", () => {
    for (const f of MODEL.files) {
      expect(f.url).toMatch(/^https:\/\/huggingface\.co\/Xenova\/all-MiniLM-L6-v2\/resolve\/[0-9a-f]{40}\//);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reports a missing model", async () => {
    const r = await root();
    const s = await modelStatus(r);
    expect(s.installed).toBe(false);
  });

  it("keeps nothing when a download does not match its checksum", async () => {
    const r = await root();
    const tampered = new Uint8Array(MODEL.files[0]!.bytes);
    await expect(fetchModel(r, serve(tampered))).rejects.toThrow(/checksum/);
    expect(await readdir(modelDir(r))).toEqual([]);
  });

  it("stops on an HTTP error", async () => {
    const r = await root();
    await expect(fetchModel(r, serve(new Uint8Array(), 404))).rejects.toThrow(/HTTP 404/);
  });

  it("refuses to load a file that was changed after download", async () => {
    const r = await root();
    await mkdir(modelDir(r), { recursive: true });
    await writeFile(join(modelDir(r), "vocab.txt"), "not the pinned vocabulary");
    await expect(readVerified(modelDir(r), "vocab.txt")).rejects.toThrow(/pinned/);
    expect(await modelVerified(r)).toBe(false);
  });

  it("removes the model directory", async () => {
    const r = await root();
    await mkdir(modelDir(r), { recursive: true });
    expect(await removeModel(r)).toBe(true);
    expect(await removeModel(r)).toBe(false);
  });
});
