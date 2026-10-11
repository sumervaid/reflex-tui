import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory (mode 0700 by default) and refuse if it, or the leaf we create, is a symlink. */
export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  if (await isSymlink(path)) throw new Error(`Refusing to use symlinked directory ${path}`);
  await mkdir(path, { recursive: true, mode });
  const st = await lstat(path);
  if (!st.isDirectory()) throw new Error(`Expected a directory at ${path}`);
}

/**
 * Write a new file. Fails if anything (file or symlink) already exists at the path, so it can
 * never overwrite an existing file or write through a planted symlink.
 */
export async function writeNewFile(path: string, content: string, mode = 0o644): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Atomically replace a file that Reflix owns. Writes a private temp file next to the target and
 * renames it into place; rename replaces a symlink itself rather than following it.
 */
export async function replaceOwnedFile(path: string, content: string, mode = 0o644): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeNewFile(tmp, content, mode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
