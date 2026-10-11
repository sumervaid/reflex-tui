import { userInfo } from "node:os";

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
  { name: "macos-home", pattern: /\/Users\/(?!Shared\b)[^/\s"'`:]+/g, replace: "~" },
  { name: "linux-home", pattern: /\/home\/[^/\s"'`:]+/g, replace: "~" },
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

function currentUserPattern(): RegExp | undefined {
  let name: string | undefined;
  try {
    name = process.env.REFLIX_REDACT_USER ?? userInfo().username;
  } catch {
    name = undefined;
  }
  if (!name || name.length < 3) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "gi");
}

const userPattern = currentUserPattern();

export type RedactionResult = { text: string; redactions: number; rules: string[] };

export function redactWithReport(input: string): RedactionResult {
  let text = input;
  let redactions = 0;
  const rules = new Set<string>();
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactions++;
      rules.add(rule.name);
      if (typeof rule.replace === "string") return rule.replace;
      const offsetIndex = args.findIndex((a) => typeof a === "number");
      const groups = args.slice(0, offsetIndex).map((a) => (typeof a === "string" ? a : ""));
      return rule.replace(...groups);
    });
  }
  if (userPattern) {
    text = text.replace(userPattern, () => {
      redactions++;
      rules.add("username");
      return "<user>";
    });
  }
  return { text, redactions, rules: [...rules] };
}

export function redact(input: string): string {
  return redactWithReport(input).text;
}

const PATH_RULES = new Set(["macos-home", "linux-home", "windows-home", "encoded-home", "email"]);

/** Redaction for file paths we generated ourselves: strip home directories and user names only. */
export function redactPath(input: string): string {
  let text = input;
  for (const rule of RULES) {
    if (!PATH_RULES.has(rule.name) || typeof rule.replace !== "string") continue;
    text = text.replace(rule.pattern, rule.replace);
  }
  return userPattern ? text.replace(userPattern, "<user>") : text;
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
  /\/Users\/[^/\s]+\//,
  /\/home\/[^/\s]+\//,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
];

/** Returns the names of leak patterns still present in text. Used to gate generated output. */
export function findLeaks(text: string): string[] {
  return LEAK_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 32));
}
