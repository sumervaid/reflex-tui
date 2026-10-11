import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeCommand } from "../src/live/search";

const saved = { PATH: process.env.PATH, REFLEX_CURSOR_DIR: process.env.REFLEX_CURSOR_DIR };
let root: string;
let workspace: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "reflex-cursor-")));
  workspace = join(root, "code", "my-app");
  await mkdir(workspace, { recursive: true });
  // Cursor names the folder after the workspace path with every "/" turned into "-".
  const encoded = workspace.slice(1).replaceAll("/", "-");
  await mkdir(join(root, "projects", encoded, "agent-transcripts", "chat-1"), { recursive: true });
  process.env.REFLEX_CURSOR_DIR = join(root, "projects");
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

describe("resuming a Cursor chat", () => {
  it("opens the chat's workspace with the cursor command when it is installed", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "cursor"), "#!/bin/sh\n");
    await chmod(join(bin, "cursor"), 0o755);
    process.env.PATH = bin;
    expect(resumeCommand({ source: "cursor", nativeId: "chat-1" })).toEqual({
      cmd: "cursor",
      args: [workspace],
      done: "opened my-app in Cursor · the chat is in its agent history",
    });
  });

  it("falls back to the Cursor app on macOS, and says so when there is no workspace", () => {
    process.env.PATH = "";
    const r = resumeCommand({ source: "cursor", nativeId: "chat-1" });
    if (process.platform === "darwin") expect(r).toMatchObject({ cmd: "open", args: ["-a", "Cursor", workspace] });
    else expect(r).toMatchObject({ ok: false, tone: "dim" });
    expect(resumeCommand({ source: "cursor", nativeId: "no-such-chat" })).toEqual({ ok: false, message: "this Cursor chat has no workspace folder on this machine", tone: "dim" });
  });

  it("refuses ids that do not look like session ids", () => {
    for (const nativeId of ["../etc", "-rf", "a b", ""]) expect(resumeCommand({ source: "codex", nativeId })).toMatchObject({ ok: false });
  });
});
