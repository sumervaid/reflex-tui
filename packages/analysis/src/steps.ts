import type { ActionCategory } from "@reflix/core";

export type StepKind = ActionCategory | "reproduce-failure" | "apply-fix";

export const MODIFY_TARGET_LABEL: Partial<Record<ActionCategory, string>> = {
  "modify-code": "source code",
  "modify-tests": "tests",
  "modify-config": "configuration",
  "modify-ci": "CI workflow",
  "modify-dependencies": "dependency declaration",
};

/** Short label for terminal display, and the imperative instruction used in generated skills. */
export const STEP_TEXT: Record<StepKind, { label: string; instruction: string }> = {
  "inspect-git": { label: "inspect repository state", instruction: "Inspect repository state: current branch, `git status`, and recent commits." },
  "inspect-diff": { label: "inspect the diff", instruction: "Inspect the diff to see exactly what changed." },
  "inspect-ci": { label: "inspect CI failure", instruction: "Inspect the failing CI run (failed job logs) and the CI workflow configuration." },
  "inspect-pr": { label: "read the pull request", instruction: "Read the pull request: description, changed files, and full diff." },
  "inspect-logs": { label: "inspect logs", instruction: "Inspect the relevant logs around the failure." },
  "inspect-repository": { label: "survey the repository", instruction: "Survey the repository layout to find the relevant area." },
  "inspect-code": { label: "read the relevant code", instruction: "Read the code and tests involved before changing anything." },
  "inspect-dependencies": { label: "inspect dependency tree", instruction: "Inspect the dependency tree and manifest to see which versions are resolved and why." },
  "search-code": { label: "search related code", instruction: "Search the codebase for related usages of the symbols involved." },
  "install-dependencies": { label: "install dependencies", instruction: "Install dependencies the same way CI does (for example with a frozen lockfile)." },
  "run-tests": { label: "run relevant tests", instruction: "Run the relevant tests." },
  "run-build": { label: "run build / typecheck", instruction: "Run the build or typecheck." },
  "run-lint": { label: "run linter", instruction: "Run the linter." },
  "run-command": { label: "run project command", instruction: "Run the project command that exercises the problem." },
  "modify-code": { label: "patch code", instruction: "Apply the smallest focused code change that addresses the root cause." },
  "modify-tests": { label: "update tests", instruction: "Update or add tests that cover the change." },
  "modify-config": { label: "patch configuration", instruction: "Apply the smallest focused configuration change that addresses the root cause." },
  "modify-ci": { label: "patch CI workflow", instruction: "Fix the CI workflow definition if the problem is in the pipeline itself." },
  "modify-dependencies": { label: "patch dependency declaration", instruction: "Update the dependency declaration (version range, pin, override, or missing direct dependency)." },
  "submit-review": { label: "post review", instruction: "Post the review on the pull request with concrete, actionable comments." },
  commit: { label: "commit", instruction: "Commit the change." },
  push: { label: "push", instruction: "Push the branch." },
  research: { label: "look up docs", instruction: "Look up external documentation for the failing tool or library." },
  summarize: { label: "summarize changes", instruction: "Summarize the root cause, what changed, and how it was verified." },
  "reproduce-failure": { label: "reproduce locally", instruction: "Reproduce the failure locally with the same command before changing anything." },
  "apply-fix": { label: "patch the root cause", instruction: "Apply the smallest focused change that addresses the root cause." },
};
