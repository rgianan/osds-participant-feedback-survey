/*
 * Checks the setup the cutover needs (docs/cutover-checklist.md). Reads only;
 * never prints a secret. Run it after each part of the setup:
 *
 *   npm run check:setup -- --site https://<site>
 *
 * Each of these, set in your shell for the run, turns on its checks:
 *   SUPABASE_DB_URL  the API's connection (transaction pooler, user portal_api.<ref>)
 *   IMPORT_DB_URL    the owner's connection (session pooler, user postgres.<ref>)
 *   WORKER_TOKEN     the site's worker token: checks the site's settings and
 *                    its database round trip from the inside
 * and --site checks the site itself: its proxy, backend, Turnstile and worker
 * endpoint.
 */
import { adaptPostgres } from "../netlify/backend/db.mjs";
import { checkApiDatabase, checkOwnerDatabase, checkSite, describeDatabaseUrl } from "./lib/setup-check.mjs";

const args = process.argv.slice(2);
const siteAt = args.indexOf("--site");
const site = siteAt >= 0 ? args[siteAt + 1] : "";
const env = (name) => String(process.env[name] || "").trim();
const apiUrl = env("SUPABASE_DB_URL");
const ownerUrl = env("IMPORT_DB_URL");
if (!site && !apiUrl && !ownerUrl) {
  console.log("Nothing to check. Pass --site https://<site>, and/or set SUPABASE_DB_URL, IMPORT_DB_URL, WORKER_TOKEN. See the top of scripts/check-setup.mjs.");
  process.exit(2);
}

const { default: postgres } = await import("postgres");
const opened = [];
const connect = (url) => async () => {
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 10, ssl: "require", onnotice: () => {} });
  opened.push(sql);
  return adaptPostgres(sql);
};

const MARK = { pass: "✓", fail: "✗", warn: "!", info: "·" };
let problems = 0;
const show = (title, results) => {
  console.log(`\n${title}`);
  for (const r of results) {
    if (r.status === "fail") problems++;
    console.log(`  ${MARK[r.status]} ${r.label}`);
    if (r.hint) console.log(`      ${r.hint}`);
  }
};
const host = (url) => describeDatabaseUrl(url)?.host || "?";

try {
  if (apiUrl) show(`API database (SUPABASE_DB_URL, ${host(apiUrl)})`, await checkApiDatabase(apiUrl, connect(apiUrl)));
  if (ownerUrl) show(`Owner connection (IMPORT_DB_URL, ${host(ownerUrl)})`, await checkOwnerDatabase(ownerUrl, connect(ownerUrl)));
  if (site) show(`Site ${site}`, await checkSite(site, { workerToken: env("WORKER_TOKEN") }));
} finally {
  await Promise.all(opened.map((sql) => sql.end({ timeout: 5 })));
}
console.log(problems ? `\n${problems} problem(s) to fix.` : "\nNo problems found.");
process.exit(problems ? 1 : 0);
