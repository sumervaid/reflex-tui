import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@reflex/core";
import { LEARNED_END, LEARNED_START, applyToOwnSkill, withoutLearned } from "../src/improve";

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-improve-file-"));
  await mkdir(join(root, "rca"));
  file = join(root, "rca", "SKILL.md");
});
afterEach(async () => {
  await chmod(file, 0o600).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("applyToOwnSkill", () => {
  it("keeps the file's permissions", async () => {
    await writeFile(file, "# rca\n", { mode: 0o600 });
    await chmod(file, 0o600);
    await applyToOwnSkill(file, sha256("# rca\n"), "# rca\nmore\n", join(root, "backups"), "rca");
    expect(await readFile(file, "utf8")).toBe("# rca\nmore\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a file you made read-only", async () => {
    await writeFile(file, "# rca\n");
    await chmod(file, 0o444);
    await expect(applyToOwnSkill(file, sha256("# rca\n"), "# rca\nmore\n", join(root, "backups"), "rca")).rejects.toThrow(/can't write/);
    expect(await readFile(file, "utf8")).toBe("# rca\n");
  });
});

describe("withoutLearned", () => {
  it("drops one clean learned section and nothing else", () => {
    const own = "# rca\n\nRead the error.\n";
    expect(withoutLearned(`${own}\n${LEARNED_START}\n- \`pnpm test\`\n${LEARNED_END}\n`)).toBe(`${own}\n\n`);
  });

  it("leaves text with broken markers alone", () => {
    const broken = `# rca\n${LEARNED_START}\nmine\n`;
    expect(withoutLearned(broken)).toBe(broken);
    const twice = `${LEARNED_START}a${LEARNED_END}${LEARNED_START}b${LEARNED_END}`;
    expect(withoutLearned(twice)).toBe(twice);
  });
});
