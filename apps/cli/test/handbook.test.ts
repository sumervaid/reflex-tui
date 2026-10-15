import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scan } from "../src/commands/scan";
import { handbook, handbookAsk, handbookExport, handbookShow } from "../src/commands/handbook";

let root: string;
let repo: string;
let output = "";
const capture = async (fn: () => Promise<void>) => {
  output = "";
  await fn();
  return output;
};

/** A Claude Code session in `repo` that edits a dependency file, runs the tests, and gets told to leave the lockfile alone. */
function session(id: string, hoursAgo: number, prompt: string, cwd: string): string {
  const t = (s: number) => new Date(Date.now() - hoursAgo * 3_600_000 + s * 1000).toISOString();
  const base = { sessionId: id, cwd };
  let n = 0;
  const tool = (name: string, input: Record<string, unknown>) => ({
    ...base,
    type: "assistant",
    timestamp: t(++n),
    message: { role: "assistant", content: [{ type: "tool_use", id: `${id}-${n}`, name, input }] },
  });
  return [
    { ...base, type: "user", timestamp: t(0), message: { role: "user", content: prompt } },
    tool("Read", { file_path: `${cwd}/package.json` }),
    tool("Edit", { file_path: `${cwd}/package.json`, old_string: "a", new_string: "b" }),
    tool("Bash", { command: "pnpm test" }),
    { ...base, type: "user", timestamp: t(9), message: { role: "user", content: "don't touch the lockfile" } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "reflex-handbook-")));
  process.env.REFLEX_HOME = join(root, "home");
  repo = join(root, "shop");
  await mkdir(join(repo, "src"), { recursive: true });
  const dir = join(root, "claude", "-shop");
  await mkdir(dir, { recursive: true });
  const prompts = ["upgrade react to the latest version", "bump vitest and fix the config", "add zod as a dependency"];
  for (const [i, p] of prompts.entries()) await writeFile(join(dir, `s${i}.jsonl`), session(`s${i}`, 30 * (i + 1), p, repo) + "\n");
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  await scan({ days: 7, claudeDir: join(root, "claude"), source: ["claude-code"], yes: true });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("reflex handbook", () => {
  it("lists the practices for the repository containing the current folder", async () => {
    const cwd = process.cwd();
    process.chdir(join(repo, "src"));
    try {
      const text = await capture(() => handbook({}));
      expect(text).toContain("Handbook · shop");
      expect(text).toContain("Run tests with `pnpm test`.");
      expect(text).toMatch(/Don't touch lockfile\. .*when changing dependencies/);
      expect(text).toContain("3 sessions");
    } finally {
      process.chdir(cwd);
    }
  });

  it("gives agents JSON with the sources behind each practice", async () => {
    const data = JSON.parse(await capture(() => handbook({ project: "shop", json: true })));
    expect(data.project.name).toBe("shop");
    const rule = data.practices.find((p: { kind: string }) => p.kind === "rule");
    expect(rule.sources).toHaveLength(3);
    expect(rule.sources[0].request).toBe("upgrade react to the latest version");

    const shown = await capture(() => handbookShow(rule.id, {}));
    expect(shown).toContain("Sessions behind it");
    expect(shown).toContain("bump vitest and fix the config");
  });

  it("answers a question from the handbook, and says so when it can't", async () => {
    const answer = await capture(() => handbookAsk(["how", "do", "I", "run", "tests?"], { project: "shop" }));
    expect(answer.split("\n").find((l) => l.startsWith("›") || l.includes("›"))).toContain("pnpm test");
    const none = await capture(() => handbookAsk(["who", "approves", "refunds?"], { project: "shop" }));
    expect(none).toContain("Nothing in the handbook for shop answers that");
  });

  it("exports a handbook without any request text", async () => {
    const md = await capture(() => handbookExport({ project: "shop" }));
    expect(md).toContain("# Handbook: shop");
    expect(md).toContain("- Run tests with `pnpm test`. · 3 sessions");
    expect(md).not.toMatch(/upgrade react|bump vitest|add zod/);
  });

  it("refuses an unknown repository", async () => {
    await expect(handbook({ project: "nope" })).rejects.toThrow(/No practices for a repository named "nope"/);
  });
});
