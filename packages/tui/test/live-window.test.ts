import { describe, expect, it } from "vitest";
import { shownDays } from "../src/live/source";

const startedAt = "2026-11-04T00:00:00.000Z";

describe("shownDays", () => {
  it("leaves windows up to a year as asked, even with little history", () => {
    expect(shownDays({ days: 7, startedAt }, [])).toBe(7);
    expect(shownDays({ days: 365, startedAt }, [{ startedAt: "2026-11-01T00:00:00.000Z" }])).toBe(365);
  });

  it("stops a longer window at the oldest session", () => {
    expect(shownDays({ days: 36500, startedAt }, [{ startedAt: "2026-11-01T00:00:00.000Z" }, { endedAt: "2026-10-05T00:00:00.000Z" }])).toBe(30);
  });

  it("never goes past the window asked for", () => {
    expect(shownDays({ days: 400, startedAt }, [{ startedAt: "2020-01-01T00:00:00.000Z" }])).toBe(400);
  });

  it("copes with no dated sessions", () => {
    expect(shownDays({ days: 36500, startedAt }, [])).toBe(365);
    expect(shownDays({ days: 36500, startedAt }, [{}])).toBe(365);
  });
});
