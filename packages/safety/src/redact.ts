import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";

type Rule = { name: string; pattern: RegExp; replace: string | ((...m: string[]) => string) };

const SENSITIVE_KEY =
  "[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|URL|URI|DSN|CREDENTIALS?|AUTH|COOKIE|SESSION)[A-Z0-9_]*";

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: "[REDACTED PRIVATE KEY]",
  },
  {
    // DATABASE_URL=..., OPENAI_API_KEY="...", export AWS_SECRET_ACCESS_KEY=...
    name: "sensitive-assignment",
    pattern: new RegExp(`\\b(${SENSITIVE_KEY})(\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`, "g"),
    replace: (_m, key, sep) => `${key}${sep.includes(":") ? ": " : "="}[REDACTED]`,
  },
  {
    // aws configure set aws_secret_access_key VALUE
    name: "aws-configure",
    pattern: /\b(aws_secret_access_key|aws_session_token|aws_access_key_id)\s+(?!\[REDACTED)[^\s"']+/gi,
    replace: (_m, key) => `${key} [REDACTED]`,
  },
  {
    // password=..., "token": "...", api_key: ...
    name: "credential-field",
    pattern:
      /(["']?)\b(password|passwd|pwd|pass|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|auth[_-]?token|private[_-]?key)\b\1(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s&,;"'}]+)/gi,
    replace: (_m, q, key, sep) => `${q}${key}${q}${sep}[REDACTED]`,
  },
  {
    name: "authorization-header",
    pattern: /\b(authorization\s*:\s*)(bearer|basic|token|bot)\s+[^\s"']+/gi,
    replace: (_m, prefix, scheme) => `${prefix}${scheme} [REDACTED]`,
  },
  { name: "bearer", pattern: /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replace: (_m, b) => `${b} [REDACTED]` },
  {
    name: "connection-string",
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse):\/\/[^\s"'`<>]+/gi,
    replace: "[REDACTED_CONNECTION_STRING]",
  },
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@"']+:[^\s@"']+@/gi, replace: (_m, s) => `${s}[REDACTED]@` },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: "[REDACTED_TOKEN]" },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED_TOKEN]" },
  { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "[REDACTED_API_KEY]" },
  { name: "google-oauth", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g, replace: "[REDACTED_TOKEN]" },
  { name: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: "[REDACTED_TOKEN]" },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: "[REDACTED_JWT]",
  },
  {
    // A whole line that looks like a dotenv entry: KEY=value
    name: "dotenv-line",
    pattern: /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{1,})=(?!\[REDACTED)(\S+)\s*$/gm,
    replace: (_m, key) => `${key}=[REDACTED]`,
  },
  {
    name: "email",
    pattern: /\b(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    replace: "[EMAIL]",
  },
  { name: "macos-home", pattern: /(?<![\w.-])\/Users\/(?!Shared\b)[^/\s"'`:]+/g, replace: "~" },
  { name: "linux-home", pattern: /(?<![\w.-])\/home\/[^/\s"'`:]+/g, replace: "~" },
  { name: "windows-home", pattern: /\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, replace: "~" },
  // Claude Code encodes project paths into directory names: -Users-alice-code-app
  { name: "encoded-home", pattern: /-(?:Users|home)-[A-Za-z0-9._]+(?=-|\b)/g, replace: "-~" },
  {
    // Long mixed-case alphanumeric strings that look like generated secrets.
    name: "high-entropy",
    pattern: /\b(?=[A-Za-z0-9+_=-]*[A-Z])(?=[A-Za-z0-9+_=-]*[a-z])(?=[A-Za-z0-9+_=-]*[0-9])[A-Za-z0-9+_=-]{40,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
];

/**
 * Login names that are also everyday words or generic accounts. They identify no one, and replacing
 * every "root cause", "run the test" or "will" in free text would reword requests and skills and skew
 * the words matching depends on, so for these only the home folder is redacted.
 */
const COMMON_NAMES = new Set([
  // System, CI and container accounts
  ...["root", "admin", "administrator", "user", "guest", "test", "tester", "dev", "developer", "build", "builder"],
  ...["runner", "deploy", "app", "node", "git", "www", "web", "server", "ubuntu", "debian", "centos", "fedora"],
  ...["alpine", "vagrant", "docker", "jenkins", "codespace", "vscode", "coder", "gitpod", "default", "owner"],
  ...["local", "home", "work", "ops", "operator", "service", "bot", "agent", "demo", "sandbox", "main", "master"],
  // Given names that are also everyday words
  ...["will", "mark", "max", "bill", "rob", "pat", "sue", "may", "june", "april", "august", "art", "grant"],
  ...["hunter", "chase", "rose", "frank", "gene", "ray", "jack", "joy", "hope", "grace", "dawn", "summer", "guy"],
]);

function currentUserName(): string | undefined {
  try {
    return process.env.REFLEX_REDACT_USER ?? userInfo().username;
  } catch {
    return undefined;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The current user's home folder wherever a path starts with it, including homes outside /home and
 * /Users (`/root`, `/var/lib/jenkins`), and their login name as a word anywhere, unless it is in
 * COMMON_NAMES.
 */
function userRules(): Rule[] {
  const rules: Rule[] = [];
  const name = currentUserName();
  const homeFolder = homedir().replace(/[\\/]+$/, "");
  if (homeFolder.length >= 2) {
    rules.push({ name: "home", pattern: new RegExp(`(?<![\\w.-])${escapeRegExp(homeFolder)}(?![\\w.-])`, "g"), replace: "~" });
  }
  if (name && name.length >= 3 && !COMMON_NAMES.has(name.toLowerCase())) {
    rules.push({ name: "username", pattern: new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), replace: "<user>" });
  }
  return rules;
}

const USER_RULES = userRules();

/**
 * What user-specific redaction depends on (the user name and home folder), hashed. Stored traces
 * record it so a change can be detected; the rules themselves change only with Reflex's code.
 */
export function redactionFingerprint(): string {
  const name = currentUserName() ?? "";
  return createHash("sha256").update(`${name}\n${homedir()}`).digest("hex").slice(0, 16);
}

/** Redact every string inside a JSON-like value (for stored data whose source can no longer be re-read). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

export type RedactionResult = { text: string; redactions: number; rules: string[] };

export function redactWithReport(input: string): RedactionResult {
  let text = input;
  let redactions = 0;
  const rules = new Set<string>();
  for (const rule of [...RULES, ...USER_RULES]) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactions++;
      rules.add(rule.name);
      if (typeof rule.replace === "string") return rule.replace;
      const offsetIndex = args.findIndex((a) => typeof a === "number");
      const groups = args.slice(0, offsetIndex).map((a) => (typeof a === "string" ? a : ""));
      return rule.replace(...groups);
    });
  }
  return { text, redactions, rules: [...rules] };
}

export function redact(input: string): string {
  return redactWithReport(input).text;
}

const PATH_RULES = new Set(["macos-home", "linux-home", "windows-home", "encoded-home", "email", "home", "username"]);

/** Redaction for file paths we generated ourselves: strip home directories and user names only. */
export function redactPath(input: string): string {
  let text = input;
  for (const rule of [...RULES, ...USER_RULES]) {
    if (!PATH_RULES.has(rule.name) || typeof rule.replace !== "string") continue;
    text = text.replace(rule.pattern, rule.replace);
  }
  return text;
}

/** Text past a length limit that is redacted too, so a secret crossing the limit is still seen whole. */
const REDACT_MARGIN = 1024;

/** Redact, then cut to `max` characters. Cutting first could leave a piece of a secret too short to match. */
export function redactTruncated(input: string, max: number): string {
  return redact(input.slice(0, max + REDACT_MARGIN)).slice(0, max);
}

/** Redact, collapse whitespace and truncate for display. */
export function excerpt(input: string, maxLength = 160): string {
  const flat = redact(input).replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? flat.slice(0, maxLength - 1).trimEnd() + "…" : flat;
}

const LEAK_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s[]+/i,
  /(?<![\w.-])\/Users\/[^/\s]+\//,
  /(?<![\w.-])\/home\/[^/\s]+\//,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
];

/** Returns the names of leak patterns still present in text. Used to gate generated output. */
export function findLeaks(text: string): string[] {
  return LEAK_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 32));
}
