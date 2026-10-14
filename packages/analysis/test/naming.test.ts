import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import type { WorkflowInstance } from "../src/dedup";
import { distinctiveTerms, termContext } from "../src/suggest";

const trace = (intents: string[], actions = ["inspect-code", "modify-code", "run-tests"]) => ({ intents, actionSequence: actions }) as unknown as WorkflowTrace;
const inst = (t: WorkflowTrace) => ({ id: "x", primary: t, merged: [] }) as WorkflowInstance;

describe("suggestion names", () => {
  // A cluster of slugify-test sessions inside a history where "src", "ts", "maybe" and "change" are everywhere.
  const cluster = [
    trace(["write", "test", "slugify", "src", "ts", "maybe", "change", "dependency"]),
    trace(["test", "slugify", "helper", "src", "ts", "maybe", "change", "depend"]),
    trace(["cover", "slugify", "test", "src", "ts", "change", "depend"]),
  ];
  const behaviors = [["inspect-ci", "install-dependencies", "run-build"], ["inspect-git", "inspect-diff"], ["inspect-repository", "modify-config", "run-lint"]];
  const rest = Array.from({ length: 20 }, (_, i) => trace(["src", "ts", "maybe", "change", `other${i}`], behaviors[i % 3]));
  const ctx = termContext([...cluster, ...rest]);
  const names = distinctiveTerms(cluster.map(inst), ctx);

  it("leads with what sets the cluster apart", () => {
    expect(names[0]).toBe("slugify");
    expect(names).toContain("test");
  });

  it("leaves out path fragments and words generic in any language", () => {
    for (const w of ["src", "ts", "maybe", "change"]) expect(names).not.toContain(w);
  });

  it("names a stem once", () => {
    expect(names.filter((w) => w.startsWith("depend"))).toHaveLength(1);
  });
});
