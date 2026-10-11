import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { redact } from "./redact";

/** Collapse the home directory and strip user names so a path is safe to print. */
export function displayPath(path: string): string {
  const home = homedir();
  let p = path;
  if (home && (p === home || p.startsWith(home + "/"))) p = "~" + p.slice(home.length);
  return redact(p);
}

export function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertInside(base: string, target: string): string {
  const resolved = resolve(target);
  if (!isInside(base, resolved)) {
    throw new Error(`Refusing to touch a path outside ${displayPath(base)}`);
  }
  return resolved;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value) && !value.endsWith("-") && !value.includes("--");
}

/** Turn arbitrary text into a filesystem-safe skill name. Never returns path separators or dots. */
export function toSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "workflow";
}

export function assertSlug(value: string): string {
  if (!isValidSlug(value)) {
    throw new Error(`Invalid skill name "${value.slice(0, 60)}". Use lowercase letters, digits and single hyphens.`);
  }
  return value;
}
