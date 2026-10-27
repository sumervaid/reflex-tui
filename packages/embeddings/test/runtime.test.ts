import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchRuntime, RUNTIME, runtimeDir, runtimeVerified, tarFiles, verifyRuntime } from "../src/runtime";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-runtime-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A USTAR archive with one regular file, optionally split across the name prefix. */
function tarOf(entries: Array<{ name: string; prefix?: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, "utf8");
    h.write((e.data.length).toString(8).padStart(11, "0") + "\0", 124, "utf8");
    h.write("0", 156, "utf8");
    if (e.prefix) h.write(e.prefix, 345, "utf8");
    h.write("ustar\0", 257, "utf8");
    parts.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe("runtime archive", () => {
  it("reads regular files by full path, joining the USTAR prefix", () => {
    const tar = tarOf([
      { name: "ort.mjs", prefix: "package/dist", data: Buffer.from("console.log(1)") },
      { name: "package.json", data: Buffer.from("{}") },
    ]);
    const files = tarFiles(tar);
    expect([...files.keys()]).toEqual(["package/dist/ort.mjs", "package.json"]);
    expect(files.get("package/dist/ort.mjs")!.toString()).toBe("console.log(1)");
  });

  it("refuses a download that does not match npm's integrity value, and keeps nothing", async () => {
    const tgz = gzipSync(tarOf([{ name: "x", data: Buffer.from("not the runtime") }]));
    const fetcher = async () => ({ ok: true, status: 200, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength) });
    await expect(fetchRuntime(root, fetcher)).rejects.toThrow(/pinned checksum; nothing was kept/);
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a failed HTTP response without writing anything", async () => {
    const fetcher = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(fetchRuntime(root, fetcher)).rejects.toThrow(/HTTP 503/);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("installed runtime", () => {
  it("is refused when a file is missing, and says how to fix it", async () => {
    await expect(verifyRuntime(runtimeDir(root))).rejects.toThrow(/not installed.*reflex model fetch/);
    expect(await runtimeVerified(root)).toBe(false);
  });

  it("is refused when a file was changed, and says how to fix it", async () => {
    const dir = runtimeDir(root);
    await mkdir(dir, { recursive: true });
    for (const f of RUNTIME.files) await writeFile(join(dir, f.name), "tampered");
    await expect(verifyRuntime(dir)).rejects.toThrow(/does not match the pinned embedding runtime/);
  });

  it("lives beside the models, one folder per pinned version", () => {
    expect(runtimeDir(root)).toBe(join(root, "runtime", `onnxruntime-web-${RUNTIME.version}`));
  });
});

/** The real download from the npm registry: network, and about 32 MB. Run with REFLEX_TEST_NETWORK=1. */
describe.skipIf(!process.env.REFLEX_TEST_NETWORK)("real runtime download", () => {
  it("installs the two pinned files and they verify", async () => {
    await fetchRuntime(root, (url) => fetch(url));
    await verifyRuntime(runtimeDir(root));
  }, 300_000);
});
