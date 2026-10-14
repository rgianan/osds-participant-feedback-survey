import { randomUUID } from "node:crypto";
import { getAdminSession } from "./auth.mjs";
import { hashPassword } from "./crypto.mjs";

/**
 * Administrator accounts (the Users and Whitelist sheets, now one table).
 * Superadmins only, with Code.gs's rules and wording.
 */

const trim = (value) => String(value ?? "").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function requireSuperadmin(context, token) {
  const session = await getAdminSession(context, token);
  if (!session) throw new Error("Forbidden: administrator authorization required.");
  if (session.role !== "superadmin") throw new Error("Forbidden: superadmin access required.");
  return session;
}

/** The 'U-xxxxxxxx' ID the Whitelist sheet gave every account; new accounts get one too. */
const newUserId = () => `U-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

const day = (column) => `to_char(${column} at time zone 'Asia/Manila', 'YYYY-MM-DD')`;

export async function adminGetUsers(body, context) {
  await requireSuperadmin(context, body?.adminToken);
  return context.db.query(
    `select coalesce(legacy_user_id, '') as user_id, name, role::text as role, email, active,
            ${day("created_at")} as created_at, ${day("updated_at")} as updated_at
       from portal.admin_users
      order by created_at, email`,
  );
}

export async function adminSaveUser(body, context) {
  const session = await requireSuperadmin(context, body?.adminToken);
  const payload = body?.payload || {};
  const email = trim(payload.email).toLowerCase();
  const name = trim(payload.name);
  const role = trim(payload.role).toLowerCase();
  const active = payload.active !== false && String(payload.active).toLowerCase() !== "false";
  const password = String(payload.password ?? "");

  if (!name) throw new Error("Name is required.");
  if (!EMAIL.test(email)) throw new Error("A valid email is required.");
  if (!["admin", "superadmin"].includes(role)) throw new Error("Role must be admin or superadmin.");
  if (session.email === email && (role !== "superadmin" || !active))
    throw new Error("You cannot demote or deactivate your own superadmin account.");

  const [existing] = await context.db.query(
    `select legacy_user_id, created_at::text as created_at from portal.admin_users where email = $1`,
    [email],
  );
  if (!existing && password.length < 12) throw new Error("New users require a password of at least 12 characters.");
  if (password && password.length < 12) throw new Error("Passwords must contain at least 12 characters.");

  const now = context.now.toISOString();
  const credentials = password ? await hashPassword(password) : null;
  let saved;
  if (existing) {
    // Deactivating or demoting takes effect on the account's next request:
    // every request re-reads the account (getAdminSession).
    [saved] = await context.db.query(
      `update portal.admin_users
          set name = $2, role = $3, active = $4, updated_at = $5,
              password_hash = coalesce($6, password_hash), password_salt = coalesce($7, password_salt),
              legacy_user_id = coalesce(legacy_user_id, $8)
        where email = $1
        returning legacy_user_id, created_at`,
      [email, name, role, active, now, credentials?.hash ?? null, credentials?.salt ?? null,
       trim(payload.user_id) || newUserId()],
    );
  } else {
    [saved] = await context.db.query(
      `insert into portal.admin_users (email, legacy_user_id, name, role, active, password_hash, password_salt, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       returning legacy_user_id, created_at`,
      [email, trim(payload.user_id) || newUserId(), name, role, active, credentials.hash, credentials.salt, now],
    );
  }
  // The same fields Code.gs's upsertWhitelistUser_ returned.
  return {
    user_id: saved.legacy_user_id,
    name,
    role,
    email,
    active,
    created_at: new Date(saved.created_at).toISOString(),
    updated_at: now,
  };
}
