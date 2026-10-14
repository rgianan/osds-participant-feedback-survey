/**
 * Dates as the portal reads them: calendar days in the Philippines,
 * whatever region the function happens to run in. Apps Script did the same
 * through the project's Asia/Manila time zone.
 */
export const PORTAL_TIME_ZONE = "Asia/Manila";

/** Days the feedback form stays open after the end date (FEEDBACK_GRACE_DAYS in Code.gs). */
export const FEEDBACK_GRACE_DAYS = 0;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PORTAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A Date → 'yyyy-MM-dd' as the calendar reads in Manila at that instant. */
export const dateKey = (date) => dayFormat.format(date);

/** 'yyyy-MM-dd' moved by whole days. Pure calendar arithmetic, no time zone involved. */
export function shiftDateKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Is the feedback window open on `today`? Keys sort as dates, so plain string
 * comparison is enough. A missing end date means a one-day activity.
 */
export function isFeedbackWindowOpen(fromKey, toKey, today, graceDays = FEEDBACK_GRACE_DAYS) {
  const to = toKey || fromKey;
  if (fromKey && today < fromKey) return false;
  if (to && today > shiftDateKey(to, graceDays)) return false;
  return true;
}
