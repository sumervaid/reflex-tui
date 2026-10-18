import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bundledPackages, thirdPartyNotices } from "../build/notices";

let root: string;
async function pkg(name: string, license: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, "node_modules/.pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license }));
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
  return `node_modules/.pnpm/${name.replace("/", "+")}@1.0.0/node_modules/${name}/index.js`;
}

describe("third-party notices", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reflex-notices-"));
  });

  it("include each bundled package's license and NOTICE, once per package", async () => {
    const inputs = [
      await pkg("left-pad", "MIT", { LICENSE: "MIT License\n\nCopyright (c) Left Pad" }),
      await pkg("@acme/tok", "Apache-2.0", { "LICENSE.txt": "Apache License 2.0 text", NOTICE: "Acme tokenizers\nCopyright Acme" }),
      "src/main.ts",
    ];
    inputs.push(inputs[0]!.replace("index.js", "lib/other.js"));
    const packages = bundledPackages(inputs, root);
    expect(packages.map((p) => `${p.name} ${p.license}`)).toEqual(["@acme/tok Apache-2.0", "left-pad MIT"]);
    const text = thirdPartyNotices(packages);
    expect(text).toContain("## @acme/tok 1.0.0 (Apache-2.0)\n\nApache License 2.0 text\n\nAcme tokenizers\nCopyright Acme");
    expect(text).toContain("## left-pad 1.0.0 (MIT)\n\nMIT License\n\nCopyright (c) Left Pad");
  });

  it("fail for a license outside the allowlist or a package with no license text", async () => {
    const packages = bundledPackages([await pkg("copyleft", "GPL-3.0", { LICENSE: "GPL" }), await pkg("bare", "MIT")], root);
    expect(() => thirdPartyNotices(packages)).toThrow(/bare@1\.0\.0 has no license file[\s\S]*copyleft@1\.0\.0 is licensed GPL-3\.0/);
  });

  it("use the MIT text with the known copyright for packages published without a license file", async () => {
    const text = thirdPartyNotices(bundledPackages([await pkg("onnxruntime-web", "MIT")], root));
    expect(text).toContain("Copyright (c) Microsoft Corporation.");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain("ThirdPartyNotices.txt");
  });

  // CI builds before testing; locally this runs after `pnpm build`.
  const built = new URL("../dist/THIRD_PARTY_NOTICES.md", import.meta.url);
  it.runIf(existsSync(built))("ship with the built CLI, covering what it bundles", () => {
    const text = readFileSync(built, "utf8");
    for (const name of ["commander", "@huggingface/tokenizers", "onnxruntime-web", "zod"]) expect(text).toContain(`## ${name} `);
    expect(existsSync(new URL("../dist/metafile-esm.json", import.meta.url))).toBe(false);
  });
});
