import {
  hashPassword,
  newSessionToken,
  sha256Base64,
  sessionTokenHash,
  verifyPassword,
} from "./crypto.mjs";

/**
 * Sign-in, sessions and sign-out, ported from Code.gs with the same replies
 * and error wording. Sessions live in portal.admin_sessions under a hash of
 * their token, and last 6 hours from sign-in.
 */

const SESSION_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const THROTTLE_MINUTES = 15;
const INVALID = "Invalid email or password.";

const trim = (value) => String(value ?? "").trim();

/** Code.gs adminLoginThrottleKey_: the throttle is keyed by a hash, never the address. */
const throttleKey = (email) => `LOGIN_ATTEMPTS_${sha256Base64(email || "unknown").slice(0, 32)}`;

export async function adminLogin(body, { db, now, secrets }) {
  const email = trim(body?.email).toLowerCase();
  const password = String(body?.password ?? "");
  const key = throttleKey(email);

  // Five attempts, then locked until 15 minutes after the latest. Counted
  // before the password is checked, so a correct password cannot be used to
  // probe past the lock.
  const [throttle] = await db.query(
    `select attempts, last_attempt_at > $2::timestamptz - interval '${THROTTLE_MINUTES} minutes' as recent
       from portal.login_attempts where email_hash = $1`,
    [key, now.toISOString()],
  );
  if (throttle?.recent && throttle.attempts >= MAX_ATTEMPTS)
    throw new Error("Too many sign-in attempts. Try again in 15 minutes.");
  await db.query(
    `insert into portal.login_attempts (email_hash, attempts, last_attempt_at) values ($1, 1, $2)
     on conflict (email_hash) do update set
       attempts = case when portal.login_attempts.last_attempt_at > $2::timestamptz - interval '${THROTTLE_MINUTES} minutes'
                       then portal.login_attempts.attempts + 1 else 1 end,
       last_attempt_at = $2`,
    [key, now.toISOString()],
  );

  const [user] = await db.query(
    `select email, name, role::text as role, active, password_hash, password_salt
       from portal.admin_users where email = $1`,
    [email],
  );
  if (!user || !user.active) throw new Error(INVALID);
  const verified = await verifyPassword(password, user.password_salt, user.password_hash, secrets?.passwordPepper);
  if (!verified.ok) throw new Error(INVALID);

  // Best-effort: a failed re-hash must not fail a correct sign-in.
  if (verified.upgrade) {
    try {
      const { hash, salt } = await hashPassword(password);
      await db.query(
        `update portal.admin_users set password_hash = $2, password_salt = $3, updated_at = now() where email = $1`,
        [email, hash, salt],
      );
    } catch (error) {
      console.error(`Password re-hash failed: ${error?.message || error}`);
    }
  }

  await db.query(`delete from portal.login_attempts where email_hash = $1`, [key]);
  // Every sign-in also clears sessions that ran out, so the table never grows unbounded.
  await db.query(`delete from portal.admin_sessions where expires_at < $1`, [now.toISOString()]);

  const token = newSessionToken();
  const expiresAt = now.getTime() + SESSION_MS;
  await db.query(
    `insert into portal.admin_sessions (token_hash, email, created_at, expires_at) values ($1, $2, $3, $4)`,
    [sessionTokenHash(token), email, now.toISOString(), new Date(expiresAt).toISOString()],
  );
  const signedIn = { email, name: user.name || email, role: user.role || "admin" };
  return { token, user: signedIn, expiresAt };
}

/**
 * The signed-in administrator for this token, or null. Looked up at most once
 * per request (`sessions` is created per request), and refused once expired
 * or once the account is deactivated: both end the session for good.
 */
export async function getAdminSession(context, token) {
  token = trim(token);
  if (!token) return null;
  const memo = context.sessions;
  if (memo?.has(token)) return memo.get(token);
  const tokenHash = sessionTokenHash(token);
  const [row] = await context.db.query(
    `select s.email, (extract(epoch from s.expires_at) * 1000)::bigint::text as expires_at,
            u.name, u.role::text as role, u.active
       from portal.admin_sessions s
       join portal.admin_users u on u.email = s.email
      where s.token_hash = $1`,
    [tokenHash],
  );
  let session = null;
  if (row) {
    const expiresAt = Number(row.expires_at);
    if (expiresAt > context.now.getTime() && row.active)
      session = { email: row.email, name: row.name || row.email, role: row.role || "admin", expiresAt };
    else await context.db.query(`delete from portal.admin_sessions where token_hash = $1`, [tokenHash]);
  }
  memo?.set(token, session);
  return session;
}

export async function adminValidateSession(body, context) {
  const session = await getAdminSession(context, body?.adminToken);
  if (!session) throw new Error("Your admin session has expired.");
  return {
    user: { email: session.email, name: session.name, role: session.role },
    expiresAt: session.expiresAt,
  };
}

export async function adminLogout(body, context) {
  const token = trim(body?.adminToken);
  context.sessions?.delete(token);
  if (token)
    await context.db.query(`delete from portal.admin_sessions where token_hash = $1`, [sessionTokenHash(token)]);
  return true;
}
