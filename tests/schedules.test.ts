import { describe, expect, it } from "vitest";
import { dueSchedules, nextRun } from "../src/lib/schedules";

describe("scheduled runs", () => {
  const base = { id: "s", projectId: "p", prompt: "check CI", on: true };
  it("computes the next run", () => {
    const t = new Date(2026, 9, 22, 9, 30).getTime();
    expect(nextRun({ ...base, every: 15 }, t)).toBe(t + 15 * 60_000);
    expect(nextRun({ ...base, at: "10:00" }, t)).toBe(new Date(2026, 9, 22, 10, 0).getTime());
    expect(nextRun({ ...base, at: "09:30" }, t)).toBe(new Date(2026, 9, 23, 9, 30).getTime());
    expect(nextRun({ ...base, at: "25:00" }, t)).toBeUndefined();
    expect(nextRun({ ...base, every: 0 }, t)).toBeUndefined();
  });
  it("lists only enabled, due schedules", () => {
    const l = [{ ...base, next: 5 }, { ...base, id: "off", on: false, next: 1 }, { ...base, id: "later", next: 50 }, { ...base, id: "blank", prompt: " ", next: 1 }];
    expect(dueSchedules(l, 10).map((s) => s.id)).toEqual(["s"]);
  });
});
