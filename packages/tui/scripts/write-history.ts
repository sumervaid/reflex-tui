// Dev helper for scripts/live-smoke.mjs: write @reflex/test-fixtures transcripts under a folder.
// Usage (bundled by live-smoke.mjs): node write-history.js <root>
import { writeFixtureHistory } from "@reflex/test-fixtures";

const root = process.argv[2];
if (!root) {
  console.error("usage: write-history <root>");
  process.exit(2);
}
const h = await writeFixtureHistory(root);
console.log(JSON.stringify(h));
