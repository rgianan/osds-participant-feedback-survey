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
let site = siteAt >= 0 ? args[siteAt + 1] : "";
const env = (name) => String(process.env[name] || "").trim();
let apiUrl = env("SUPABASE_DB_URL");
let ownerUrl = env("IMPORT_DB_URL");
let workerToken = env("WORKER_TOKEN");

/** One line from the terminal. `hidden`: what is typed or pasted is not shown, and never reaches shell history. */
async function ask(question, hidden) {
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      // Nothing was shown, so say what arrived: a doubled paste shows as twice the length.
      if (hidden) process.stdout.write(answer.trim() ? `  (received ${answer.trim().length} characters)\n` : "  (skipped)\n");
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

if (!site && !apiUrl && !ownerUrl) {
  if (!process.stdin.isTTY) {
    console.log("Nothing to check. Pass --site https://<site>, and/or set SUPABASE_DB_URL, IMPORT_DB_URL, WORKER_TOKEN. See the top of scripts/check-setup.mjs.");
    process.exit(2);
  }
  // Run in a terminal with nothing set: ask, so no secret is typed on a command line.
  console.log("Paste each value when asked, or press Enter to skip it. Connection strings and tokens are not shown as you paste.\n");
  apiUrl = await ask("API connection string (SUPABASE_DB_URL): ", true);
  ownerUrl = await ask("Owner connection string (IMPORT_DB_URL): ", true);
  site = await ask("Site address to check, e.g. https://example.netlify.app: ", false);
  if (site && !workerToken) workerToken = await ask("That site's worker token (WORKER_TOKEN): ", true);
  if (!site && !apiUrl && !ownerUrl) process.exit(2);
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
  if (site) show(`Site ${site}`, await checkSite(site, { workerToken }));
} finally {
  await Promise.all(opened.map((sql) => sql.end({ timeout: 5 })));
}
console.log(problems ? `\n${problems} problem(s) to fix.` : "\nNo problems found.");
process.exit(problems ? 1 : 0);
