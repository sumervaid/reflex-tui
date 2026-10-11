import { defineConfig } from "tsup";

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
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __reflexCreateRequire } from 'node:module';\nconst require = __reflexCreateRequire(import.meta.url);",
  },
});
