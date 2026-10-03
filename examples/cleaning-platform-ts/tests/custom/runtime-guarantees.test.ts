// Hand-written test: guarantees of the generated runtime's time values and of JSON round trips.

import { describe, expect, test } from "vitest";

import {
  CleaningStaffInvitation,
  type CleaningStaffInvitationInput,
} from "../../src/cleaning_platform/generated/cleaning-staff/domain/aggregates.js";
import {
  InvitationIssued,
  parseCleaningStaffEvent,
} from "../../src/cleaning_platform/generated/cleaning-staff/domain/events.js";
import {
  addDays,
  addDuration,
  ConstraintViolation,
  days,
  daysBetween,
  durationBetween,
  earliest,
  hours,
  instant,
  InstantSchema,
  latest,
  localDate,
  minutes,
  subtractDuration,
  toDate,
} from "../../src/cleaning_platform/generated/runtime.js";

const invitationInput = {
  id: "00000000-0000-0000-0000-000000000001",
  email: { value: "staff@example.com" },
  status: "pending",
  createdAt: "2026-01-01T10:00:00+00:00",
  expiresAt: "2026-01-08T19:00:00+09:00",
} as const;

describe("Instant", () => {
  test("an offset string, a Z string and a Date give the same canonical UTC string", () => {
    const fromOffset = instant("2026-01-08T19:00:00+09:00");
    expect(fromOffset).toBe("2026-01-08T10:00:00.000Z");
    expect(instant("2026-01-08T10:00:00Z")).toBe(fromOffset);
    expect(instant(new Date(Date.UTC(2026, 0, 8, 10)))).toBe(fromOffset);
    expect(instant(fromOffset)).toBe(fromOffset);
    // Precision is milliseconds.
    expect(InstantSchema.parse("2026-01-08T10:00:00.123456Z")).toBe("2026-01-08T10:00:00.123Z");
  });

  test("invalid values and years outside 0001-9999 (UTC) are rejected", () => {
    const bad = [
      "not a date",
      "2026-01-08",
      "2026-01-08T10:00:00",
      "2026-02-30T10:00:00Z",
      "0000-06-01T00:00:00Z",
      "0001-01-01T00:30:00+01:00",
      "9999-12-31T23:30:00-01:00",
    ];
    for (const value of bad) expect(() => instant(value), value).toThrow(ConstraintViolation);
    expect(() => instant(new Date(Number.NaN))).toThrow(ConstraintViolation);
    expect(() => instant(new Date(Date.UTC(10000, 0, 1)))).toThrow(ConstraintViolation);
    expect(instant("0001-01-01T00:00:00Z")).toBe("0001-01-01T00:00:00.000Z");
    expect(instant("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
  });

  test("string order is time order, and === is value equality", () => {
    const tokyo = instant("2026-01-08T19:00:00+09:00"); // 10:00 UTC
    const london = instant("2026-01-08T10:30:00+00:00");
    // The raw inputs would sort the other way round; the canonical form does not.
    expect("2026-01-08T19:00:00+09:00" < "2026-01-08T10:30:00+00:00").toBe(false);
    expect(tokyo < london).toBe(true);
    expect(earliest(tokyo, london)).toBe(tokyo);
    expect(latest(tokyo, london)).toBe(london);
    expect(tokyo === instant(new Date(Date.UTC(2026, 0, 8, 10)))).toBe(true);
    const values = ["9999-01-01T00:00:00Z", "0001-01-01T00:00:00Z", "2026-01-01T00:00:00+14:00"];
    const byString = values.map((v) => instant(v)).sort();
    const byTime = values.map((v) => instant(v)).sort((a, b) => durationBetween(a, b));
    expect(byString).toEqual(byTime);
  });

  test("duration helpers", () => {
    const at = instant("2026-01-01T10:00:00Z");
    expect(addDuration(at, days(7))).toBe("2026-01-08T10:00:00.000Z");
    expect(subtractDuration(at, hours(1))).toBe("2026-01-01T09:00:00.000Z");
    expect(durationBetween(addDuration(at, hours(24)), at)).toBe(hours(24));
    expect(durationBetween(at, addDuration(at, minutes(1)))).toBe(-60_000);
    expect(() => addDuration(instant("9999-12-31T23:00:00Z"), hours(2))).toThrow(
      ConstraintViolation,
    );
  });

  test("toDate gives a new Date; changing a Date never changes validated state", () => {
    const at = instant("2026-01-08T10:00:00Z");
    const copy = toDate(at);
    copy.setUTCFullYear(2000);
    expect(toDate(at).getTime()).toBe(Date.UTC(2026, 0, 8, 10));
    const input = new Date(Date.UTC(2026, 0, 8, 10));
    const invitation = CleaningStaffInvitation.from({ ...invitationInput, expiresAt: input });
    input.setUTCFullYear(2030);
    expect(invitation.expiresAt).toBe("2026-01-08T10:00:00.000Z");
  });
});

describe("LocalDate", () => {
  test("calendar dates are ISO strings with day arithmetic", () => {
    const day = localDate("2026-02-27");
    expect(addDays(day, days(2))).toBe("2026-03-01");
    expect(daysBetween(localDate("2026-03-01"), day)).toBe(days(2));
    expect(() => localDate("2026-02-30")).toThrow(ConstraintViolation);
    expect(() => addDays(localDate("9999-12-31"), days(1))).toThrow(ConstraintViolation);
  });
});

describe("JSON", () => {
  test("an event round-trips; its instants are canonical strings", () => {
    const event = InvitationIssued.create({
      id: invitationInput.id,
      email: invitationInput.email,
      expiresAt: invitationInput.expiresAt,
    });
    const json = JSON.stringify(event);
    expect(json).toContain('"expiresAt":"2026-01-08T10:00:00.000Z"');
    expect(parseCleaningStaffEvent(JSON.parse(json))).toEqual(event);
  });

  test("an aggregate without entity fields round-trips through from()", () => {
    const invitation = CleaningStaffInvitation.from(invitationInput);
    const json = JSON.stringify(invitation);
    const rebuilt = CleaningStaffInvitation.from(JSON.parse(json) as CleaningStaffInvitationInput);
    expect(rebuilt).toEqual(invitation);
    expect(JSON.stringify(rebuilt)).toBe(json);
  });
});
