import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "tsup";
import { noticesFromMetafile } from "./build/notices";

// package.json is the one place the version is written; `reflex --version` prints it from here.
const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  entry: { reflex: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  bundle: true,
  // node:sqlite only exists with the node: prefix.
  removeNodeProtocol: false,
  // Ship one self-contained file: workspace packages and npm dependencies are inlined.
  noExternal: [/.*/],
  define: { __REFLEX_VERSION__: JSON.stringify(version) },
  // The metafile lists exactly what was bundled, for THIRD_PARTY_NOTICES.md; it is not shipped.
  metafile: true,
  async onSuccess() {
    const metafile = join("dist", "metafile-esm.json");
    await writeFile(join("dist", "THIRD_PARTY_NOTICES.md"), noticesFromMetafile(metafile, process.cwd()));
    await rm(metafile);
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __reflexCreateRequire } from 'node:module';\nconst require = __reflexCreateRequire(import.meta.url);",
  },
});
