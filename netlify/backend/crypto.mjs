import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/**
 * Apps Script's Utilities.base64EncodeWebSafe: the URL-safe alphabet, but
 * WITH '=' padding (Node's "base64url" drops it). The legacy password hash
 * feeds that padded text back into itself 12,000 times, so the difference
 * matters.
 */
const webSafe = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

export const sha256WebSafe = (value) =>
  webSafe(createHash("sha256").update(String(value), "utf8").digest());

/** Code.gs sha256Base64_ and hmac256Base64_: web-safe base64, padding stripped. */
export const sha256Base64 = (value) => sha256WebSafe(value).replace(/=+$/, "");
export const hmacBase64 = (value, secret) =>
  webSafe(createHmac("sha256", String(secret)).update(String(value), "utf8").digest()).replace(/=+$/, "");

export function constantTimeEquals(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // same work either way
    return false;
  }
  return timingSafeEqual(x, y);
}

/** 64 hex characters of randomness, the same shape as the Apps Script token. */
export const newSessionToken = () => randomBytes(32).toString("hex");
/** Sessions are stored by this hash; the token itself is never written down. */
export const sessionTokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

/** 'CHED-' + 20 uppercase hex characters, as makeVerificationCode_. */
export const newVerificationCode = () =>
  `CHED-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
/** 'AUD-' + 16 uppercase hex characters, as the audit writer in Code.gs. */
export const newAuditId = () => `AUD-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;

// --- Passwords --------------------------------------------------------------
//
// Three formats can be on file:
//   legacy   12,000 rounds of SHA-256 (hashAdminPasswordLegacy_)
//   v2:…     one HMAC-SHA256 keyed with PASSWORD_PEPPER (hashAdminPasswordV2_)
//   scrypt:… what this backend writes
// Both Apps Script formats are re-stored as scrypt at the account's next
// successful sign-in. Once every account has been, PASSWORD_PEPPER can go.

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export function legacyPasswordHash(password, salt) {
  let value = `${salt ?? ""}|${password ?? ""}`;
  for (let i = 0; i < 12000; i++) value = sha256WebSafe(value);
  return value;
}

export const v2PasswordHash = (password, salt, pepper) =>
  `v2:${hmacBase64(`${salt ?? ""}|${password ?? ""}`, pepper)}`;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { hash: `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${key.toString("base64url")}`, salt };
}

/** → { ok, upgrade }. `upgrade` means: re-store this password as scrypt. */
export async function verifyPassword(password, salt, stored, pepper) {
  stored = String(stored ?? "").trim();
  if (stored.startsWith("scrypt:")) {
    const [, N, r, p, expected] = stored.split(":");
    const key = await scrypt(String(password), String(salt), SCRYPT.keylen, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return { ok: constantTimeEquals(key.toString("base64url"), expected), upgrade: false };
  }
  if (stored.startsWith("v2:")) {
    if (!pepper)
      throw new Error("Sign-in is not configured: set PASSWORD_PEPPER in the site's environment variables to the value from Apps Script.");
    const ok = constantTimeEquals(v2PasswordHash(password, salt, pepper), stored);
    return { ok, upgrade: ok };
  }
  const ok = constantTimeEquals(legacyPasswordHash(password, salt), stored);
  return { ok, upgrade: ok };
}
