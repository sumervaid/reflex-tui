import { afterEach, describe, expect, it, vi } from "vitest";
import { excerpt, findLeaks, redact, redactPath, redactTruncated, redactWithReport, redactionFingerprint } from "../src/redact";
import { assertInside, displayPath, isValidSlug, toSlug } from "../src/paths";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";

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
  ["GitLab token", "git clone with glpat-abcdEFGH1234ijklMNOP5678", "glpat-abcdEFGH1234ijklMNOP5678"],
  ["Hugging Face token", "huggingface-cli login hf_abcdefghijklmnopqrstuvwxyz012345", "hf_abcdefghijklmnopqrstuvwxyz012345"],
  ["password flag", "mysql -u app --password hunter2 -h db", "hunter2"],
  ["quoted password flag", 'mysql --password "two words" -h db', "two words"],
  ["Docker token", "docker login -p dckr_pat_abcdefghijklmnopqrstuvw12", "dckr_pat_abcdefghijklmnopqrstuvw12"],
  ["SendGrid key", `send SG.${"a1".repeat(11)}.${"b2".repeat(21)}c now`, `SG.${"a1".repeat(11)}`],
  ["Twilio key", `twilio SK${"0123456789abcdef".repeat(2)} now`, `SK${"0123456789abcdef".repeat(2)}`],
  ["Discord webhook", "curl https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL", "abcDEF_ghi-JKL"],
  ["GCP private_key_id", '{"private_key_id": "0123456789abcdef0123456789abcdef01234567"}', "0123456789abcdef0123456789abcdef01234567"],
  ["Visa number", "charge 4111111111111111 now", "4111111111111111"],
  ["card number with spaces", "card 5500 0055 5555 5559 expired", "5500 0055 5555 5559"],
  ["card number with dashes", "card 4242-4242-4242-4242.", "4242-4242-4242-4242"],
  ["Amex number", "amex 3782 822463 10005 ok", "3782 822463 10005"],
  ["public IPv4", "ssh deploy 203.0.113.42", "203.0.113.42"],
  ["IPv4 with a port", "curl http://203.0.113.42:8080/health", "203.0.113.42"],
  ["private IPv4", "ping 192.168.1.20", "192.168.1.20"],
  ["IPv6", "ssh 2001:db8:85a3::8a2e:370:7334 now", "2001:db8:85a3::8a2e:370:7334"],
  ["bracketed IPv6", "curl http://[2001:db8::1]:8080/", "2001:db8::1"],
  ["full IPv6", "ping 2001:0db8:0000:0000:0000:ff00:0042:8329", "2001:0db8:0000:0000:0000:ff00:0042:8329"],
  ["IPv4-mapped IPv6", "from ::ffff:203.0.113.42 ok", "203.0.113.42"],
];

describe("what stays as written", () => {
  it.each([
    ["a --password-stdin flag", "docker login --password-stdin -u me"],
    ["a --password with no value", "mysql --password --host db"],
    ["a --password placeholder", "mysql --password <value>"],
    ["words that start like a token", "the hf_ prefix and SK and glpat- and SG.x.y"],
    ["a long number that fails the card check", "order 4111111111111112 shipped"],
    ["a long number with no card prefix", "id 1775256320109 and 9999999999999995"],
    ["a card-shaped number inside a longer one", "ref 41111111111111119999999"],
    ["loopback IPv4", "curl http://127.0.0.1:3000 and 127.0.1.1"],
    ["the any address", "listen on 0.0.0.0:8080"],
    ["loopback IPv6", "bind ::1 and ::"],
    ["three-part versions", "bump 1.2.3 to 10.20.30"],
    ["four-part versions", "v1.2.3.4 and foo@1.2.3.4 and version 1.2.3.4"],
    ["numbers past 255", "build 1.2.3.456 and 2026.10.23.1"],
    ["a longer dotted number", "oid 1.3.6.1.4.1"],
    ["clock times", "at 12:30:45 and 09:15"],
    ["code paths", "std::vector and abc::def and add::"],
    ["a MAC address", "aa:bb:cc:dd:ee:ff"],
  ])("%s", (_, input) => {
    expect(redact(input)).toBe(input);
    expect(redactWithReport(input).redactions).toBe(0);
  });

  it("redacts a card next to another number without taking both", () => {
    expect(redact("4111111111111111 12")).toBe("[REDACTED_CARD] 12");
  });

  it("is stable when run again", () => {
    const once = redact("mysql --password hunter2 203.0.113.42 4111111111111111");
    expect(redact(once)).toBe(once);
  });
});

describe("redactionFingerprint", () => {
  it("covers the rules as well as the user, so kept traces are redacted again when they change", () => {
    const identityOnly = createHash("sha256").update(`${process.env.REFLEX_REDACT_USER ?? userInfo().username}\n${homedir()}`).digest("hex").slice(0, 16);
    expect(redactionFingerprint()).toMatch(/^[0-9a-f]{16}$/);
    expect(redactionFingerprint()).not.toBe(identityOnly);
  });
});

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

  it("only treats /home and /Users at the start of a path as a home directory", () => {
    expect(redact("open file:///Users/alice/a.txt")).toBe("open file://~/a.txt");
    expect(redactPath("/tmp/reflex-x1/home/reflex.db")).toBe("/tmp/reflex-x1/home/reflex.db");
    expect(redactPath("/srv/app/Users/list.ts")).toBe("/srv/app/Users/list.ts");
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

describe("redactTruncated", () => {
  const token = "Ab1" + "x9Yz".repeat(15);
  const key = "sk-ant-api03-" + "Q7wErTyUiOpAsDfG".repeat(3);

  it("redacts a secret that crosses the limit before cutting", () => {
    for (const secret of [token, key]) {
      for (const keep of [5, 14, 38]) {
        const text = "a ".repeat(500) + secret;
        const max = text.length - secret.length + keep;
        const out = redactTruncated(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toContain(secret.slice(0, keep));
      }
    }
  });

  it("keeps text under the limit as redact would", () => {
    expect(redactTruncated("run pnpm test", 2000)).toBe("run pnpm test");
    expect(redactTruncated("x".repeat(3000), 10)).toBe("x".repeat(10));
  });
});

describe("the current user", () => {
  // The rules are built when the module loads, so each case loads it again with that user name.
  async function redactAs(name: string) {
    vi.stubEnv("REFLEX_REDACT_USER", name);
    vi.resetModules();
    return import("../src/redact");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("redacts a distinctive login name anywhere", async () => {
    const { redact, redactPath } = await redactAs("nihar");
    expect(redact("ask Nihar to review /srv/nihar/app")).toBe("ask <user> to review /srv/<user>/app");
    expect(redactPath("/srv/nihar/app")).toBe("/srv/<user>/app");
  });

  it("leaves everyday words alone when the login name is one of them", async () => {
    for (const name of ["root", "test", "build", "will", "admin", "dev"]) {
      const { redact } = await redactAs(name);
      const text = `Apply the smallest focused change that addresses the root cause. It will build, then run the test as admin in dev.`;
      expect(redact(text)).toBe(text);
    }
  });

  it("still redacts the home folder, wherever it is", async () => {
    for (const home of ["/root", "/var/lib/jenkins"]) {
      vi.stubEnv("HOME", home);
      const { redact, redactPath } = await redactAs(home === "/root" ? "root" : "jenkins");
      expect(redact(`cat ${home}/.zshrc`)).toBe("cat ~/.zshrc");
      expect(redactPath(`${home}/.claude/skills`)).toBe("~/.claude/skills");
      expect(redact(`ls ${home}fs/bin ${home}.bak`)).toBe(`ls ${home}fs/bin ${home}.bak`);
    }
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
