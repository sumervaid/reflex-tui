import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { cursorModels } from "../src/live/source";

const trace = (source: string, models: string[], usage?: WorkflowTrace["usage"]) => ({ source, models, usage }) as unknown as WorkflowTrace;

describe("cursorModels", () => {
  it("lists only Cursor sessions without token counts, by model", () => {
    const traces = [
      trace("cursor", ["composer-2"]),
      trace("cursor", ["composer-2"]),
      trace("cursor", ["claude-sonnet-5-5"], { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      trace("claude-code", ["claude-opus-4-7"]),
    ];
    expect(cursorModels(traces)).toEqual([{ name: "composer-2", sessions: 2 }]);
    expect(cursorModels([traces[2]!])).toBeUndefined();
  });
});
