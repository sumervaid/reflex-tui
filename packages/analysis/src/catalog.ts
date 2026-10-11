import type { StepKind } from "./steps";

/**
 * Labels for well-known workflow families. Used only to name a cluster that was already formed
 * from behavior; a family is chosen only if the cluster's consensus actions satisfy `requires`.
 */
export type Family = {
  slug: string;
  title: string;
  description: string;
  whenToUse: string;
  terms: string[];
  requires: (steps: Set<StepKind>, fileCategories: Set<string>) => boolean;
};

const has = (s: Set<StepKind>, ...k: StepKind[]) => k.some((x) => s.has(x));
const modifies = (s: Set<StepKind>) => has(s, "apply-fix", "modify-code", "modify-config", "modify-ci", "modify-dependencies", "modify-tests");
const verifies = (s: Set<StepKind>) => has(s, "run-tests", "run-build", "run-lint");

export const FAMILIES: Family[] = [
  {
    slug: "fix-ci",
    title: "Fix CI failures before merging",
    description: "Diagnose and repair CI failures before merging.",
    whenToUse: "Use when a branch or pull request is failing CI (for example GitHub Actions) and the cause needs to be found and fixed before merging.",
    terms: ["ci", "fail", "build", "lint", "merge", "main", "action", "job"],
    requires: (s) => s.has("inspect-ci") && modifies(s) && verifies(s),
  },
  {
    slug: "review-pr",
    title: "Review pull requests before approving",
    description: "Review a pull request's changes, check them locally, and report concrete findings.",
    whenToUse: "Use when asked to review, check, or look over a pull request or branch before it is approved or merged.",
    terms: ["review", "pr", "bug", "comment", "change", "branch", "approve"],
    requires: (s) => has(s, "inspect-pr", "inspect-diff") && !modifies(s),
  },
  {
    slug: "debug-dependency",
    title: "Debug dependency and install failures",
    description: "Find and fix dependency resolution, version, and install failures.",
    whenToUse: "Use when installs fail, a module cannot be resolved, versions conflict, or something broke after a dependency upgrade.",
    terms: ["dependency", "install", "version", "upgrade", "resolve", "lockfile", "peer", "module", "find"],
    requires: (s) => s.has("inspect-dependencies") && has(s, "modify-dependencies", "install-dependencies"),
  },
  {
    slug: "investigate-production-issue",
    title: "Investigate production issues",
    description: "Investigate a production error from logs to root cause.",
    whenToUse: "Use when investigating an error, incident, or unexpected behavior in a deployed environment.",
    terms: ["prod", "production", "incident", "log", "outage", "alert", "latency"],
    requires: (s) => s.has("inspect-logs"),
  },
  {
    slug: "prepare-migration",
    title: "Prepare database migrations",
    description: "Draft and check a database migration.",
    whenToUse: "Use when adding or changing a database schema migration.",
    terms: ["migration", "schema", "sql", "index", "column", "table"],
    requires: (_s, files) => files.has("migration"),
  },
  {
    slug: "prepare-release",
    title: "Prepare a release",
    description: "Prepare, verify, and publish a release.",
    whenToUse: "Use when cutting a release, bumping versions, or preparing a changelog.",
    terms: ["release", "version", "changelog", "tag", "publish"],
    requires: (s) => has(s, "commit", "push") && verifies(s),
  },
];
