import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentLaunch, findOnPath } from "../src/spawn";

/** A Windows machine with these files on it (file names ignore case there). */
const windows = (files: string[], env: NodeJS.ProcessEnv = {}) => ({
  platform: "win32" as const,
  env: { Path: "C:\\Tools;C:\\Users\\a\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe", ...env },
  isFile: (p: string) => files.some((f) => f.toLowerCase() === p.toLowerCase()),
});

describe("agentLaunch", () => {
  it("starts the command as is outside Windows", () => {
    expect(agentLaunch("claude", ["-p", "fix it"], { platform: "linux" })).toEqual({ command: "claude", args: ["-p", "fix it"] });
  });

  it("starts an .exe directly, by its full path, with any argument", () => {
    const host = windows(["C:\\Tools\\claude.exe", "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"]);
    expect(agentLaunch("claude", ['say "hi"', "50%"], host)).toEqual({ command: "C:\\Tools\\claude.exe", args: ['say "hi"', "50%"] });
  });

  it("runs a .cmd launcher through cmd.exe with every argument quoted", () => {
    const host = windows(["C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"]);
    expect(agentLaunch("claude", ["--resume", "fix a & b | c > d", "C:\\dir with space\\"], host)).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", '""C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd" "--resume" "fix a & b | c > d" "C:\\dir with space\\\\""'],
      windowsVerbatimArguments: true,
    });
  });

  it("refuses what cmd.exe cannot pass to a .cmd launcher unchanged", () => {
    const host = windows(["C:\\Tools\\codex.cmd"]);
    for (const arg of ['say "hi"', "make it 50% faster", "%PATH%", "two\nlines", "a\rb"]) {
      expect(() => agentLaunch("codex", [arg], host)).toThrow(/batch launcher.*quotes, % or line breaks/);
    }
  });

  it("leaves a program that is not on PATH to spawn, which reports it missing", () => {
    expect(agentLaunch("claude", ["-p", "x"], windows([]))).toEqual({ command: "claude", args: ["-p", "x"] });
  });
});

describe("findOnPath", () => {
  it("tries each PATHEXT extension in each folder, in order", () => {
    const host = windows(["C:\\Users\\a\\AppData\\Roaming\\npm\\cursor.cmd", "C:\\Users\\a\\AppData\\Roaming\\npm\\cursor.exe"]);
    expect(findOnPath("cursor", host)).toBe("C:\\Users\\a\\AppData\\Roaming\\npm\\cursor.exe");
    expect(findOnPath("cursor.cmd", host)).toBe("C:\\Users\\a\\AppData\\Roaming\\npm\\cursor.cmd");
    expect(findOnPath("code", host)).toBeUndefined();
  });

  it("looks for the bare name on PATH elsewhere", () => {
    const host = { platform: "darwin" as const, env: { PATH: "/usr/bin:/opt/cursor/bin" }, isFile: (p: string) => p === "/opt/cursor/bin/cursor" };
    expect(findOnPath("cursor", host)).toBe("/opt/cursor/bin/cursor");
    expect(findOnPath("codex", host)).toBeUndefined();
  });
});

describe.runIf(process.platform === "win32")("on Windows", () => {
  /** An npm-style launcher: a .cmd that passes its arguments on to node with %*. */
  function fakeAgent(): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), "reflex-spawn-"));
    writeFileSync(join(dir, "echo.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    writeFileSync(join(dir, "fake-agent.cmd"), `@"${process.execPath}" "%~dp0\\echo.js" %*\r\n`);
    return { dir, env: { ...process.env, Path: `${dir};${process.env.Path ?? process.env.PATH ?? ""}` } };
  }

  it("passes arguments through an npm-style .cmd launcher unchanged", () => {
    const { dir, env } = fakeAgent();
    const args = ["-p", "fix a & b | c > d < e", "(parens) ^caret! and spaces", `${dir}\\`, ""];
    const launch = agentLaunch("fake-agent", args, { env });
    const res = spawnSync(launch.command, launch.args, { encoding: "utf8", windowsVerbatimArguments: launch.windowsVerbatimArguments });
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.stdout)).toEqual(args);
  });

  it("finds a .cmd launcher that spawn alone cannot start", () => {
    const { env } = fakeAgent();
    expect(spawnSync("fake-agent", ["x"], { env }).error).toBeDefined();
    expect(findOnPath("fake-agent", { env })).toMatch(/fake-agent\.cmd$/i);
  });
});
