import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { auditCanonical } from "../../netlify/backend/audit.mjs";
import { hmacBase64, legacyPasswordHash, sha256Base64, v2PasswordHash } from "../../netlify/backend/crypto.mjs";

/**
 * Passwords and audit entries written by Apps Script must verify here, byte
 * for byte. This runs the real Code.gs functions in a sandbox, with Utilities
 * stood in by Node's crypto as Google documents them (UTF-8 input; web-safe
 * base64 output that KEEPS its '=' padding), and compares results with the port.
 */
function codeGs() {
  const bytes = (buffer) => [...buffer].map((b) => (b > 127 ? b - 256 : b)); // Apps Script returns signed bytes
  const context = {
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_alg, value) => bytes(createHash("sha256").update(String(value), "utf8").digest()),
      computeHmacSha256Signature: (value, key) => bytes(createHmac("sha256", String(key)).update(String(value), "utf8").digest()),
      base64EncodeWebSafe: (data) => Buffer.from(data.map((b) => b & 255)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "PASSWORD_PEPPER" ? "pepper-from-gas" : null) }) },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../../google-apps-script/Code.gs", import.meta.url), "utf8"), context);
  return context;
}

test("v2 and legacy password hashes match Code.gs exactly, including non-ASCII passwords", () => {
  const gas = codeGs();
  for (const [password, salt] of [["correct horse battery", "salt-1"], ["Pässwörd–ñ 2026!", "c0ffee"], ["", ""]]) {
    assert.equal(v2PasswordHash(password, salt, "pepper-from-gas"), gas.hashAdminPasswordV2_(password, salt));
    assert.equal(legacyPasswordHash(password, salt), gas.hashAdminPasswordLegacy_(password, salt));
  }
});

test("audit entry hashes match Code.gs, including a timestamp Sheets stripped of its zero", () => {
  const gas = codeGs();
  const entry = {
    logged_at: "2026-08-19 2:42:24", audit_id: "AUD-0123456789ABCDEF", actor_email: "boss@example.com",
    actor_role: "superadmin", action: "LOGIN", target_type: "session", target_id: "boss@example.com",
    outcome: "SUCCESS", details: "{}", request_id: "req-1", previous_hash: "prev",
  };
  const gasEntry = { ...entry, timestamp: entry.logged_at };
  assert.equal(auditCanonical(entry), gas.auditCanonical_(gasEntry));
  assert.equal(hmacBase64(auditCanonical(entry), "audit-secret"), gas.hmac256Base64_(gas.auditCanonical_(gasEntry), "audit-secret"));
  assert.equal(sha256Base64("someone@example.com"), gas.sha256Base64_("someone@example.com"));
});
