import { describe, expect, it } from "vitest";
import { classifyCommand, fileCategory, normalizeSegment } from "../src/classify";
import { intentTerms } from "../src/intents";

describe("command normalization", () => {
  it("generalizes arguments", () => {
    expect(normalizeSegment("git diff src/a.ts")).toBe("git diff <file>");
    expect(normalizeSegment("git diff src/b.ts")).toBe("git diff <file>");
    expect(normalizeSegment("gh run view 8812345 --log-failed")).toBe("gh run view <n> --log-failed");
    expect(normalizeSegment("DATABASE_URL=[REDACTED] npm test")).toBe("npm test");
    expect(normalizeSegment("npx vitest run src/x.test.ts")).toBe("vitest <arg> <file>");
    expect(normalizeSegment("pnpm run build")).toBe("pnpm run build");
  });

  it("classifies actions", () => {
    const action = (c: string) => classifyCommand(c).map((f) => f.action);
    expect(action("git status")).toEqual(["inspect-git"]);
    expect(action("gh pr checks 41")).toEqual(["inspect-ci"]);
    expect(action("gh pr diff 41")).toEqual(["inspect-pr"]);
    expect(action("gh pr review 41 --comment -b 'x'")).toEqual(["submit-review"]);
    expect(action("pnpm install --frozen-lockfile")).toEqual(["install-dependencies"]);
    expect(action("npm ci")).toEqual(["install-dependencies"]);
    expect(action("pnpm why react")).toEqual(["inspect-dependencies"]);
    expect(action("pnpm test -- cart")).toEqual(["run-tests"]);
    expect(action("npm run typecheck")).toEqual(["run-build"]);
    expect(action("pnpm lint")).toEqual(["run-lint"]);
    expect(action("cat .github/workflows/ci.yml")).toEqual(["inspect-ci"]);
    expect(action("sed -n '1,80p' package.json")).toEqual(["inspect-dependencies"]);
    expect(action("rm -rf node_modules && pnpm install")).toEqual(["install-dependencies", "install-dependencies"]);
    expect(action("gh run view --log-failed | tail -50")).toEqual(["inspect-ci"]);
    expect(action("kubectl logs api-7f9")).toEqual(["inspect-logs"]);
  });

  it("categorizes files", () => {
    expect(fileCategory(".github/workflows/ci.yml")).toBe("ci-config");
    expect(fileCategory("~/code/app/pnpm-lock.yaml")).toBe("dependency-manifest");
    expect(fileCategory("src/cart.test.ts")).toBe("test");
    expect(fileCategory("tsconfig.json")).toBe("config");
    expect(fileCategory("migrations/001_init.sql")).toBe("migration");
    expect(fileCategory("src/index.ts")).toBe("source");
  });
});

describe("intent terms", () => {
  it("folds synonyms onto shared terms", () => {
    expect(intentTerms("Can you figure out why GitHub Actions fails?")).toEqual(["ci", "fail"]);
    expect(intentTerms("why is CI broken?")).toEqual(["ci", "fail"]);
    expect(intentTerms("review this pull request")).toEqual(["review", "pr"]);
  });

  it("drops redaction markers and URLs", () => {
    expect(intentTerms("token [REDACTED_TOKEN] at https://x.dev/a")).toEqual(["token"]);
  });
});
