import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ensureDir, replaceOwnedFile } from "@reflex/safety";
import { type Fetcher, sha256Hex } from "./model";

/**
 * The WebAssembly runtime onnxruntime-web runs the embedding model with. It is not shipped in the
 * npm package (it is 14 MB, and only needed after `reflex model fetch`): `fetchRuntime` takes the
 * two files from the pinned release tarball on the npm registry, and each file is checked against
 * its SHA-256 before it is kept. The tarball itself is checked against npm's own integrity value.
 */
export const RUNTIME = {
  version: "1.29.0",
  tarball: "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.29.0.tgz",
  integrity: "sha512-LuQlpX6MFLJZu756erwUeb1mNfoJGbs1kzDwJGNlf5RvfYMdqhcY3vNpDPK40CUV2HoWTkIj+uS0o36GFHjeYw==",
  files: [
    {
      name: "ort-wasm-simd-threaded.wasm",
      entry: "package/dist/ort-wasm-simd-threaded.wasm",
      bytes: 13_961_845,
      sha256: "ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d",
    },
    {
      name: "ort-wasm-simd-threaded.mjs",
      entry: "package/dist/ort-wasm-simd-threaded.mjs",
      bytes: 24_218,
      sha256: "5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747",
    },
  ],
} as const;

/** Where the runtime lives: beside the models, one folder per pinned version. */
export const runtimeDir = (modelsRoot: string): string => join(modelsRoot, "runtime", `onnxruntime-web-${RUNTIME.version}`);

/** The regular files of a USTAR tar archive, by path. Only what the pinned entries need is read; every kept file is hash-checked. */
export function tarFiles(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const field = (h: Buffer, at: number, len: number) => h.toString("utf8", at, at + len).replace(/\0[\s\S]*$/, "").trim();
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("The embedding runtime archive is corrupt; nothing was kept.");
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const type = header[156];
    const start = at + 512;
    if ((type === 0x30 || type === 0) && start + size <= tar.length) out.set(name, tar.subarray(start, start + size));
    at = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Download the pinned runtime into `modelsRoot`. Nothing is kept unless the tarball and both files match their pins. */
export async function fetchRuntime(modelsRoot: string, fetcher: Fetcher): Promise<string> {
  const res = await fetcher(RUNTIME.tarball);
  if (!res.ok) throw new Error(`Download of the embedding runtime failed (HTTP ${res.status}).`);
  const tgz = Buffer.from(await res.arrayBuffer());
  if (`sha512-${createHash("sha512").update(tgz).digest("base64")}` !== RUNTIME.integrity) {
    throw new Error("The embedding runtime download does not match its pinned checksum; nothing was kept.");
  }
  const entries = tarFiles(gunzipSync(tgz));
  const dir = runtimeDir(modelsRoot);
  const checked = RUNTIME.files.map((f) => {
    const data = entries.get(f.entry);
    if (!data || data.length !== f.bytes || sha256Hex(data) !== f.sha256) {
      throw new Error(`${f.name} in the embedding runtime archive does not match the pinned version; nothing was kept.`);
    }
    return { f, data };
  });
  await ensureDir(modelsRoot);
  await ensureDir(dir);
  for (const { f, data } of checked) await replaceOwnedFile(join(dir, f.name), data, 0o644);
  return dir;
}

/**
 * Check the runtime files in `dir` byte for byte. Throws with the next step when one is missing or
 * changed: the runtime is loaded from disk on every scan, so it is verified on every load too.
 */
export async function verifyRuntime(dir: string): Promise<void> {
  for (const f of RUNTIME.files) {
    const data = await readFile(join(dir, f.name)).catch(() => undefined);
    if (!data) throw new Error(`The embedding runtime is not installed (${f.name} is missing). Run \`reflex model fetch\`.`);
    if (data.length !== f.bytes || sha256Hex(data) !== f.sha256) {
      throw new Error(`${f.name} does not match the pinned embedding runtime. Run \`reflex model fetch\` again.`);
    }
  }
}

/** Whether the runtime in `modelsRoot` is installed and verified. */
export async function runtimeVerified(modelsRoot: string): Promise<boolean> {
  try {
    await verifyRuntime(runtimeDir(modelsRoot));
    return true;
  } catch {
    return false;
  }
}
