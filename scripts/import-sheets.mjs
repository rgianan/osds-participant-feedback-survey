/*
 * Phase 3 of the migration: load the sheets into the new database.
 *
 *   npm run import:sheets -- <export.json> [--dry-run] [--skip-responses] [--replace] [--discard-new-data]
 *
 * <export.json> is the file exportForMigration() writes to Drive. Everything
 * happens in one transaction, checked before it commits (scripts/lib/import.mjs):
 * the rows field by field, the audit chain, and every screen against Code.gs
 * run on the same export. Any failure writes nothing.
 *
 *   --dry-run            load into a throwaway in-memory database instead, run
 *                        every check, and write nothing anywhere. Start here.
 *   --skip-responses     leave the responses in Sheets (they are tests)
 *   --replace            replace a database that already holds data
 *   --discard-new-data   with --replace: also delete responses and audit
 *                        entries made through the new backend, which the sheets
 *                        do not have (a staging rehearsal's tests)
 *
 * Environment (set in your shell for the run; never commit them):
 *   AUDIT_HASH_SECRET  the audit log's key, from Apps Script's Script Properties
 *   IMPORT_DB_URL      not needed for --dry-run. The database OWNER's connection
 *                      string: Supabase → Connect → Session pooler, user
 *                      postgres.<project-ref>. --replace needs the owner, and
 *                      portal_api cannot be used for it.
 *
 * Output names sheets, row numbers and counts, never participants' details.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { importSheets, minuteStamp } from "./lib/import.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const known = ["--dry-run", "--skip-responses", "--replace", "--discard-new-data"];
const files = args.filter((a) => !a.startsWith("--"));
const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};
const unknown = [...flags].filter((f) => !known.includes(f));
if (unknown.length) fail(`Unknown option ${unknown.join(", ")}. Options: ${known.join(", ")}.`);
if (files.length !== 1) fail("Usage: npm run import:sheets -- <export.json> [--dry-run] [--skip-responses] [--replace] [--discard-new-data]");
if (flags.has("--discard-new-data") && !flags.has("--replace")) fail("--discard-new-data only applies with --replace.");
const dryRun = flags.has("--dry-run");
const auditSecret = String(process.env.AUDIT_HASH_SECRET || "").trim();
if (!auditSecret) fail("Set AUDIT_HASH_SECRET to the value in Apps Script's Script Properties: the import checks the audit chain with it.");
const url = String(process.env.IMPORT_DB_URL || "").trim();
if (!dryRun && !url) fail("Set IMPORT_DB_URL to the database owner's connection string, or run with --dry-run first.");

let exported;
try {
  exported = JSON.parse(readFileSync(files[0], "utf8"));
} catch (error) {
  fail(`Could not read ${files[0]}: ${error.message}`);
}

const list = (lines) => lines.forEach((line) => console.log(`  - ${line}`));
const rows = (name) => (Array.isArray(exported?.sheets?.[name]) ? Math.max(0, exported.sheets[name].length - 1) : "missing");
console.log(`Export ${basename(files[0])}, made ${exported?.exportedAt ? `${minuteStamp(new Date(exported.exportedAt))} (Manila)` : "at an unknown time"}`);
console.log(`  rows: ${["Activity", "Responses", "Questions", "Users", "Whitelist", "Audit"].map((n) => `${n} ${rows(n)}`).join(" · ")}`);

let db;
let close = async () => {};
let target;
if (dryRun) {
  const { readdirSync } = await import("node:fs");
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort())
    await pg.exec(readFileSync(new URL(file, migrations), "utf8"));
  const wrap = (runner) => ({ query: async (text, params = []) => (await runner.query(text, params)).rows });
  db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
  close = () => pg.close();
  target = "a throwaway in-memory database (dry run)";
} else {
  const { default: postgres } = await import("postgres");
  const { adaptPostgres } = await import("../netlify/backend/db.mjs");
  let host = "the database";
  try {
    host = new URL(url).hostname;
  } catch {}
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, ssl: "require", onnotice: () => {} });
  db = adaptPostgres(sql);
  close = () => sql.end({ timeout: 5 });
  target = host;
}

let result;
try {
  result = await importSheets(db, exported, {
    skipResponses: flags.has("--skip-responses"),
    replace: flags.has("--replace"),
    discardNewData: flags.has("--discard-new-data"),
    auditSecret,
  });
} catch (error) {
  await close();
  fail(`The import stopped: ${error.message}\nNothing was written.`, 1);
}
await close();

if (result.notes.length) {
  console.log("\nNotes");
  list(result.notes);
}
if (!result.ok) {
  if (result.stage === "convert") {
    console.log(`\n${result.problems.length} row(s) the new database would refuse. Fix them in Sheets, export again, and rerun:`);
    list(result.problems);
  } else if (result.stage === "target") console.log(`\n${result.message}`);
  else {
    console.log("\nThe import loaded, but its checks failed, so it was rolled back:");
    list(result.failures);
  }
  console.log("\nNothing was written.");
  process.exit(1);
}

console.log(`\nLoaded into ${target}`);
console.log(`  ${Object.entries(result.counts).map(([table, n]) => `${table} ${n}`).join(" · ")}`);
if (result.replaced) console.log(`  replacing what it held before: ${Object.entries(result.replaced.replaced).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
console.log("\nChecks, all passed");
console.log(`  ✓ ${result.checks.rows}`);
console.log(`  ✓ audit chain: ${result.checks.auditChain}`);
console.log(`  ✓ the same as Apps Script (this repository's Code.gs) on: ${result.checks.appsScript.join(", ")}`);
if (result.checks.responsesCompared !== "all") console.log(`    Responses compared: ${result.checks.responsesCompared}; every row was checked field by field above.`);
console.log(dryRun ? "\nDry run: nothing was written. Run again without --dry-run to import." : "\nImported and committed.");
