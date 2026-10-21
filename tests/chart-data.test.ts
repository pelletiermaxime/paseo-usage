import { expect, test } from "vite-plus/test";
import { periodKeys } from "../client/chart-data";
test("the daily axis ends at the client's calendar day, including timezones behind UTC", () => {
  const keys = periodKeys("2026-10-14", "2026-10-21T02:30:00Z", false, "America/Toronto");
  expect(keys).toHaveLength(7);
  expect(keys[0]).toBe("2026-10-14");
  expect(keys.at(-1)).toBe("2026-10-20");
});
test("hourly keys preserve both repeated daylight-saving hours", () => {
  const keys = periodKeys("2026-11-01T00:30:00Z", "2026-11-02T00:30:00Z", true, "America/Toronto");
  expect(keys).toHaveLength(25);
  expect(keys).toContain("2026-11-01T05:00:00.000Z");
  expect(keys).toContain("2026-11-01T06:00:00.000Z");
});
