import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../tsup.config";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const bundle = new URL("../dist/reflex.js", import.meta.url);

describe("reflex --version", () => {
  it("is package.json's version, set at build time", () => {
    expect((config as { define?: Record<string, string> }).define).toEqual({ __REFLEX_VERSION__: JSON.stringify(pkg.version) });
    expect(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")).toContain(".version(__REFLEX_VERSION__)");
  });

  // CI builds before testing; locally this runs after `pnpm build`.
  it.runIf(existsSync(bundle))("prints package.json's version from the built CLI", () => {
    expect(execFileSync(process.execPath, [bundle.pathname, "--version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
  });
});
