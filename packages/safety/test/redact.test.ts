import { describe, expect, it } from "vitest";
import { excerpt, findLeaks, redact, redactWithReport } from "../src/redact";
import { assertInside, displayPath, isValidSlug, toSlug } from "../src/paths";
import { homedir } from "node:os";

const cases: Array<[string, string, string]> = [
  ["OPENAI_API_KEY", "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234", "sk-proj-abcdefghijklmnopqrstuvwx1234"],
  ["ANTHROPIC_API_KEY", 'ANTHROPIC_API_KEY="sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"', "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
  ["AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  [
    "AWS_SECRET_ACCESS_KEY",
    "aws configure set AWS_SECRET_ACCESS_KEY wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY && AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ],
  ["Authorization: Bearer", 'curl -H "Authorization: Bearer abc123def456ghi789" https://api.x.dev', "abc123def456ghi789"],
  [
    "JWT",
    "token was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok",
    "eyJhbGciOiJIUzI1NiJ9",
  ],
  ["DATABASE_URL", "DATABASE_URL=postgres://alice:secret@prod-db:5432/app", "alice:secret"],
  ["password=", "mysql -u root password=hunter2 --host db", "hunter2"],
  ["token=", "curl https://x.dev/api?token=abcd1234efgh&page=2", "abcd1234efgh"],
  ["json password", '{"user": "a", "password": "p@ssw0rd!"}', "p@ssw0rd!"],
  ["GitHub token", "gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["Slack token", "SLACK=xoxb-123456789012-abcdefghijkl", "xoxb-123456789012"],
  ["bare connection string", "psql mongodb+srv://u:p@cluster0.mongodb.net/db", "u:p@cluster0"],
  ["email", "ping alice.smith@example.com about it", "alice.smith@example.com"],
  ["mac home path", "cat /Users/alice/code/app/.env", "/Users/alice"],
  ["linux home path", "ls /home/bob/projects", "/home/bob"],
  ["encoded claude dir", "projects/-Users-alice-code-app/1.jsonl", "-Users-alice"],
  ["dotenv line", "STRIPE_WEBHOOK=whsec_abc123\nNODE_ENV=production", "whsec_abc123"],
];

describe("redact", () => {
  for (const [name, input, secret] of cases) {
    it(`removes ${name}`, () => {
      const out = redact(input);
      expect(out).not.toContain(secret);
      expect(findLeaks(out)).toEqual([]);
    });
  }

  it("matches the documented DATABASE_URL example exactly", () => {
    expect(redact("DATABASE_URL=postgres://alice:secret@prod-db")).toBe("DATABASE_URL=[REDACTED]");
  });

  it("redacts full private key blocks, including truncated ones", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`here:\n${key}\nthanks`)).toBe("here:\n[REDACTED PRIVATE KEY]\nthanks");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEow")).toBe("[REDACTED PRIVATE KEY]");
  });

  it("leaves ordinary developer text alone", () => {
    const text = "pnpm install && pnpm test -- --run src/a.test.ts; git diff HEAD~1";
    expect(redact(text)).toBe(text);
    expect(redact("CI=true pnpm test")).toBe("CI=true pnpm test");
    expect(redact("git clone git@github.com:acme/app.git")).toBe("git clone git@github.com:acme/app.git");
  });

  it("keeps git SHAs", () => {
    expect(redact("git show 3f2a9c1b7e4d5f6a8b9c0d1e2f3a4b5c6d7e8f90")).toContain("3f2a9c1b7e4d5f6a8b9c0d1e2f3a4b5c6d7e8f90");
  });

  it("reports which rules fired", () => {
    const r = redactWithReport("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz and bob@corp.io");
    expect(r.redactions).toBeGreaterThanOrEqual(2);
    expect(r.rules).toContain("email");
  });

  it("handles unicode and huge input without blowing up", () => {
    expect(redact("修复 CI 失败 🚀 token=秘密")).toBe("修复 CI 失败 🚀 token=[REDACTED]");
    const big = "x".repeat(500_000) + " password=abc";
    const start = Date.now();
    expect(redact(big).endsWith("password=[REDACTED]")).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("excerpt redacts, flattens and truncates", () => {
    const e = excerpt("line one\n\nAPI_TOKEN=abc " + "y".repeat(400), 80);
    expect(e).not.toContain("abc ");
    expect(e.length).toBeLessThanOrEqual(80);
    expect(e).not.toContain("\n");
  });
});

describe("paths", () => {
  it("collapses home directory", () => {
    expect(displayPath(homedir() + "/.claude/projects")).toBe("~/.claude/projects");
  });

  it("rejects traversal", () => {
    expect(() => assertInside("/tmp/base", "/tmp/base/../etc/passwd")).toThrow();
    expect(assertInside("/tmp/base", "/tmp/base/a/b")).toBe("/tmp/base/a/b");
  });

  it("produces safe slugs", () => {
    expect(toSlug("../../etc/Fix CI!!")).toBe("etc-fix-ci");
    expect(toSlug("")).toBe("workflow");
    expect(isValidSlug("fix-ci")).toBe(true);
    expect(isValidSlug("../x")).toBe(false);
    expect(isValidSlug(".hidden")).toBe(false);
    expect(isValidSlug("a/b")).toBe(false);
  });
});
