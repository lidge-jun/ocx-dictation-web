import test from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatDateTime, newSessionId } from "../lib/time.mjs";

test("timezone changes date and display across midnight", () => {
  const iso = "2026-01-01T23:30:00.000Z";
  assert.equal(formatDate(iso, "UTC"), "2026-01-01");
  assert.equal(formatDate(iso, "Asia/Seoul"), "2026-01-02");
  assert.equal(formatDateTime(iso, "UTC"), "2026-01-01 23:30 UTC");
});
test("ID uses configured zone and keeps legacy regex shape", () => {
  const now = new Date("2026-01-01T23:30:00.000Z");
  assert.match(newSessionId("Asia/Seoul", now), /^20260102-083000-[0-9a-f]{4}$/);
  assert.match(newSessionId("UTC", now), /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
});
test("invalid date fails instead of making a malformed ID", () => {
  assert.throws(() => newSessionId("UTC", new Date("invalid")), /Invalid date/);
});
