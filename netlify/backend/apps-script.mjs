/**
 * How long Netlify waits for Apps Script: under Netlify's own 30-second limit
 * on a function, so a slow Apps Script ends in this readable error instead of
 * Netlify's error page. The browser retries it (src/lib/api.js retries
 * anything that reads as a timeout), as it always has.
 */
export const APPS_SCRIPT_WAIT_MS = 25_000;
export const APPS_SCRIPT_TIMEOUT =
  "Apps Script did not answer in time (timeout after 25 seconds). Please try again.";
