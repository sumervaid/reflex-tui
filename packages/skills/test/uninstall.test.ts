import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflex/adapters";
import { analyze, buildTrace } from "@reflex/analysis";
import { sha256 } from "@reflex/core";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { type ApprovalStore, approveSuggestion } from "../src/approve";
import { type InstallTarget, install, planInstall, uninstall } from "../src/install";

let tmp: string;
let target: InstallTarget;
const CONTENT = "---\nname: fix-ci\ndescription: d\n---\n\n# Fix CI\n";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "reflex-uninstall-"));
  target = { id: "claude-code", label: "Claude Code", skillsDir: join(tmp, "skills"), detected: true };
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function installed(name = "fix-ci", content = CONTENT) {
  return install(await planInstall(target, name, content), content);
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe("uninstall", () => {
  it("removes an unchanged file and its now-empty folder", async () => {
    const rec = await installed();
    expect(await uninstall(target, rec)).toBe("removed");
    expect(await exists(join(target.skillsDir, "fix-ci"))).toBe(false);
    expect(await exists(target.skillsDir)).toBe(true);
  });

  it("keeps a file edited since install", async () => {
    const rec = await installed();
    await writeFile(rec.path, CONTENT + "my notes\n");
    expect(await uninstall(target, rec)).toBe("edited");
    expect(await readFile(rec.path, "utf8")).toBe(CONTENT + "my notes\n");
  });

  it("reports a file that is already gone", async () => {
    const rec = await installed();
    await rm(join(target.skillsDir, "fix-ci"), { recursive: true });
    expect(await uninstall(target, rec)).toBe("missing");
  });

  it("keeps the folder when the user added files next to SKILL.md", async () => {
    const rec = await installed();
    await writeFile(join(target.skillsDir, "fix-ci", "notes.md"), "mine");
    expect(await uninstall(target, rec)).toBe("removed");
    expect(await readdir(join(target.skillsDir, "fix-ci"))).toEqual(["notes.md"]);
  });

  it("never follows or deletes a symlinked file", async () => {
    const elsewhere = join(tmp, "elsewhere.md");
    await writeFile(elsewhere, CONTENT);
    await mkdir(join(target.skillsDir, "fix-ci"), { recursive: true });
    const path = join(target.skillsDir, "fix-ci", "SKILL.md");
    await symlink(elsewhere, path);
    expect(await uninstall(target, { path, contentHash: sha256(CONTENT) })).toBe("edited");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(elsewhere, "utf8")).toBe(CONTENT);
  });

  it("never deletes through a symlinked skill folder", async () => {
    const real = join(tmp, "real");
    await mkdir(real);
    await writeFile(join(real, "SKILL.md"), CONTENT);
    await mkdir(target.skillsDir, { recursive: true });
    await symlink(real, join(target.skillsDir, "fix-ci"));
    expect(await uninstall(target, { path: join(target.skillsDir, "fix-ci", "SKILL.md"), contentHash: sha256(CONTENT) })).toBe("edited");
    expect(await readFile(join(real, "SKILL.md"), "utf8")).toBe(CONTENT);
  });

  it("stays inside the target folder", async () => {
    const outside = join(tmp, "other", "fix-ci", "SKILL.md");
    await mkdir(join(tmp, "other", "fix-ci"), { recursive: true });
    await writeFile(outside, CONTENT);
    expect(await uninstall(target, { path: outside, contentHash: sha256(CONTENT) })).toBe("edited");
    expect(await uninstall(target, { path: join(target.skillsDir, "fix-ci", "..", "..", "other", "fix-ci", "SKILL.md"), contentHash: sha256(CONTENT) })).toBe("edited");
    expect(await uninstall(target, { path: join(target.skillsDir, "fix-ci", "other.md"), contentHash: sha256(CONTENT) })).toBe("edited");
    expect(await readFile(outside, "utf8")).toBe(CONTENT);
  });
});

describe("approveSuggestion", () => {
  const NOW = new Date("2026-10-11T12:00:00Z");

  async function fixCi() {
    const h = await writeFixtureHistory(join(tmp, "history"), NOW);
    const traces = [];
    for (const a of [new ClaudeCodeAdapter(h.claudeRoot), new CodexAdapter(h.codexRoot)])
      for (const f of await a.discover({ days: 7, now: NOW })) traces.push(...(await a.parse(f, { days: 7, now: NOW })).sessions.map(buildTrace));
    return analyze(traces).suggestions.find((s) => s.slug === "fix-ci")!;
  }

  function memoryStore() {
    const skills = new Map<string, { contentHash: string }>();
    const status = new Map<string, string>();
    const store: ApprovalStore = {
      skill: (name) => skills.get(name),
      saveSkill: (s) => void skills.set(s.name, s),
      setStatus: (slug, st) => void status.set(slug, st),
    };
    return { store, skills, status };
  }

  it("writes into Reflex's folder and marks the suggestion approved", async () => {
    const s = await fixCi();
    const m = memoryStore();
    const res = await approveSuggestion(m.store, { slug: s.slug, data: s }, join(tmp, "reflex"), async () => false);
    expect(res.written).toBe(true);
    expect(await readFile(res.path, "utf8")).toBe(res.skill.content);
    expect(m.skills.get("fix-ci")?.contentHash).toBe(res.skill.contentHash);
    expect(m.status.get("fix-ci")).toBe("approved");
  });

  it("keeps a copy the user edited unless told to replace it", async () => {
    const s = await fixCi();
    const m = memoryStore();
    const root = join(tmp, "reflex");
    const first = await approveSuggestion(m.store, { slug: s.slug, data: s }, root, async () => false);
    await writeFile(first.path, "edited by hand\n");
    m.status.clear();
    let asked = "";
    const kept = await approveSuggestion(m.store, { slug: s.slug, data: s }, root, async (file) => {
      asked = file;
      return false;
    });
    expect(kept.written).toBe(false);
    expect(asked).toBe(first.path);
    expect(await readFile(first.path, "utf8")).toBe("edited by hand\n");
    expect(m.status.size).toBe(0);
    const replaced = await approveSuggestion(m.store, { slug: s.slug, data: s }, root, async () => true);
    expect(replaced.written).toBe(true);
    expect(await readFile(first.path, "utf8")).toBe(replaced.skill.content);
  });
});
