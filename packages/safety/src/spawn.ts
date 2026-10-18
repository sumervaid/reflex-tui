import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The machine a command is resolved for; tests pass their own. */
export type Host = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isFile?: (path: string) => boolean };

/** How to start an agent CLI with spawn/spawnSync, without a shell of Reflex's own. */
export type AgentLaunch = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Where `name` would run from: the first match on PATH, trying each PATHEXT extension on Windows
 * (`claude` is often `claude.cmd` there). Undefined when it is not on PATH.
 */
export function findOnPath(name: string, host: Host = {}): string | undefined {
  const env = host.env ?? process.env;
  const exists = host.isFile ?? isFile;
  if ((host.platform ?? process.platform) !== "win32") {
    for (const dir of (env.PATH ?? "").split(posix.delimiter)) if (dir && exists(posix.join(dir, name))) return posix.join(dir, name);
    return undefined;
  }
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean);
  const names = exts.some((e) => name.toLowerCase().endsWith(e)) ? [name] : exts.map((e) => name + e);
  for (const dir of (env.Path ?? env.PATH ?? "").split(win32.delimiter)) {
    if (!dir) continue;
    for (const n of names) if (exists(win32.join(dir, n))) return win32.join(dir, n);
  }
  return undefined;
}

/**
 * What cmd.exe cannot hand to a batch launcher unchanged: `%` expands variables even in quotes,
 * and a quote or line break ends the quoting that keeps & | < > ( ) ^ literal. npm's launchers
 * pass their arguments on with %*, which cmd.exe reads a second time.
 */
const UNSAFE_FOR_CMD = /["%\r\n\0]/;

/**
 * Start `command` with `args` the same way everywhere. On Windows, agent CLIs installed with npm
 * (and Cursor's) are .cmd launchers, which only cmd.exe can run: they get one fully quoted
 * command line, and an argument cmd.exe cannot pass safely is refused rather than reinterpreted.
 * A program not on PATH is left as is, so spawn reports it missing (ENOENT) as before.
 */
export function agentLaunch(command: string, args: string[], host: Host = {}): AgentLaunch {
  if ((host.platform ?? process.platform) !== "win32") return { command, args };
  const path = findOnPath(command, host);
  if (!path) return { command, args };
  if (!/\.(cmd|bat)$/i.test(path)) return { command: path, args };
  if ([path, ...args].some((a) => UNSAFE_FOR_CMD.test(a))) {
    throw new Error(
      `${win32.basename(path)} is a Windows batch launcher, which can't be given quotes, % or line breaks safely. Leave them out, or install ${command} as an .exe.`,
    );
  }
  // Inside quotes cmd.exe leaves & | < > ( ) ^ alone. Backslashes before a closing quote are
  // doubled so the program, which reads its command line with the usual Windows rules, keeps them.
  const line = [path, ...args].map((a) => `"${a.replace(/(\\+)$/, "$1$1")}"`).join(" ");
  const env = host.env ?? process.env;
  return { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/v:off", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
