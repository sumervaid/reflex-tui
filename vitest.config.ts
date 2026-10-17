import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Redaction replaces the login name, so pin it: results must not depend on who runs the tests.
    env: { REFLEX_REDACT_USER: "reflex-test-user" },
  },
});
