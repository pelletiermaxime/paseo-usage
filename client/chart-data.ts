export function periodKeys(
  since: string,
  until: string,
  hourly: boolean,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string[] {
  const cursor = new Date(hourly ? since : since.slice(0, 10) + "T00:00:00Z");
  if (hourly) cursor.setUTCMinutes(0, 0, 0);
  const end = new Date(until);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(end);
  const lastDay = ["year", "month", "day"]
    .map((part) => parts.find((p) => p.type === part)!.value)
    .join("-");
  const result: string[] = [];
  while (
    (hourly ? cursor <= end : cursor.toISOString().slice(0, 10) <= lastDay) &&
    result.length < (hourly ? 25 : 90)
  ) {
    result.push(hourly ? cursor.toISOString() : cursor.toISOString().slice(0, 10));
    cursor.setTime(cursor.getTime() + (hourly ? 3_600_000 : 86_400_000));
  }
  return result;
}
