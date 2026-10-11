import { defineConfig } from "tsup";

// Dev preview on the design fixture (scripts/preview.ts -> dist/preview.js) and the live smoke test's
// fixture-history writer (scripts/write-history.ts -> dist/write-history.js). Not part of the CLI build.
export default defineConfig({
  entry: { preview: "scripts/preview.ts", "write-history": "scripts/write-history.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  bundle: true,
  removeNodeProtocol: false,
  noExternal: [/.*/],
});
