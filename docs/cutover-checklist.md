# Cutover checklist: Sheets to Supabase

The runbook for moving the portal's records from Google Sheets to the Supabase database, and for moving them back if that has to be undone. Phase 4 of the migration plan rehearses all of it on staging. Phase 5 runs it for real.

- **Rehearsal (phase 4):** follow [Rehearsal on staging](#rehearsal-on-staging). It runs the [Cutover](#cutover) and [Rollback](#rollback) steps against a copy of the spreadsheet and a staging site. Production is never touched. Note how long each step takes.
- **Cutover (phase 5):** pick a day when no activity's feedback window is open. Budget 30 minutes.

Secrets go into Netlify, Script Properties or your own shell for one command. They never go into this repository, a chat or a document.

## What each part does

| Part | Where | Purpose |
|---|---|---|
| `MAINTENANCE_MODE=on` | Netlify environment | The proxy turns away anything that changes data (submissions, sign-ins, admin saves) with "The portal is being upgraded…". Reads still work, so certificate verification stays up. |
| `BACKEND=supabase` | Netlify environment | The proxy answers from Postgres instead of Apps Script. Unset means Apps Script. |
| `exportForMigration()` | Apps Script editor | Writes every sheet to one private JSON file in your Drive. |
| `node scripts/import-sheets.mjs` | your computer | Loads that file in one transaction, checks it, and commits only if every check passes (`scripts/import-sheets.mjs`). |
| `CERTIFICATE_SOURCE=api` | Script Properties | The one-minute certificate trigger takes its jobs from the new backend instead of the Responses sheet. |
| `previewReplayFromNewBackend()`, `replayFromNewBackend()` | Apps Script editor | Rollback: copies everything done in the new backend since the import back into the sheets. |
| `scripts/phase0-timings.js` | browser console on the site | Times every request. Target: median under 0.5 s. |
| `node scripts/check-setup.mjs` | your computer | Checks the database, the owner's connection and a site, and says what to fix. Reads only, and never shows a secret. |

Run both scripts with `node` in a terminal in this folder. They ask for every connection string and secret, and nothing you paste is shown or kept in your shell history. Paste each value once; the script then says how many characters it received. (`npm run …` works too, except in a PowerShell that blocks scripts.)

Netlify reads environment variables when it deploys. After changing one: **Deploys → Trigger deploy → Deploy site**, then wait for "Published" (about 2 minutes).

## Once, before the rehearsal

Supabase (Pro, Singapore):
- [ ] Create the project. In the SQL editor, run both files in `supabase/migrations/` in order.
- [ ] Set the API role's password: `alter role portal_api with login password '…';` Keep it in the password manager.
- [ ] Note the two connection strings from **Connect**:
  - **Transaction pooler** (port 6543), user `portal_api.<project-ref>`: this is `SUPABASE_DB_URL` in Netlify.
  - **Session pooler** (port 5432), user `postgres.<project-ref>`: this is `IMPORT_DB_URL`, used only in your shell when you import.
- [ ] Check it. Every line must show ✓ and the last must say "No problems found.":
  ```powershell
  node scripts/check-setup.mjs
  ```
  Paste the two connection strings when asked, and press Enter to skip the site.

Netlify:
- [ ] Netlify Pro, with functions in the Singapore region (**Site configuration → Functions → Region**). Do the same for the staging site.
- [ ] A staging site, deployed from the same branch, with these variables:

  | Variable | Value |
  |---|---|
  | `BACKEND` | `supabase` |
  | `SUPABASE_DB_URL` | transaction pooler string |
  | `PASSWORD_PEPPER` | production's, from Apps Script's Script Properties |
  | `AUDIT_HASH_SECRET` | production's, from Script Properties |
  | `PORTAL_BASE_URL` | the staging site's `https://` address |
  | `GAS_WEB_APP_URL`, `SUBMIT_SHARED_TOKEN`, `WORKER_TOKEN` | the spreadsheet copy's (below) |
  | `TURNSTILE_SECRET_KEY` | as production |
  | `VITE_USE_NETLIFY_PROXY` | `true` |
  | `VITE_TURNSTILE_SITE_KEY` | as production (it is public) |

  The two `VITE_` variables are read when the site is built, so set them before its first deploy, or deploy again after.

- [ ] In Cloudflare Turnstile, add the staging hostname to the widget's hostnames. Without it, every submission and sign-in fails the security check.
- [ ] On the production site, add `SUPABASE_DB_URL`, `PASSWORD_PEPPER`, `AUDIT_HASH_SECRET` and `WORKER_TOKEN` now (production's own token, from `setupWorkerToken()` in production's script). Leave `BACKEND` unset. Nothing changes until it is set.

## Rehearsal on staging

Production's sheets, script and site are left alone. The rehearsal works on a fresh copy of the spreadsheet, made the same day, so its data matches production's.

The copy holds real participants' details, and its script still writes to production's Drive folders. Three rules keep the rehearsal from reaching real people or files:
- **Import with `--skip-responses`.** Otherwise the staging queue would make and email certificates for real participants still waiting for one. The dry run without it still proves the responses import.
- **In the rehearsed rollback, skip step 4.** The copy's own trigger would email those same participants from its Responses sheet.
- **Never run `resetTestingData()` in the copy.** It empties the certificates folder, which is production's.

Set up the copy (about 15 minutes):
- [ ] **File → Make a copy** of the spreadsheet. Its script comes with it. Its triggers do not.
- [ ] In the copy's Apps Script editor, open **Project Settings → Script Properties**. Make sure `AUDIT_HASH_SECRET` and `PASSWORD_PEPPER` hold production's values; add them if they are missing. Do this before the next step, which would otherwise invent a new audit secret.
- [ ] Make sure `CERTIFICATE_QUEUE_TRIGGER_READY` is `1`, adding it if missing. Without it, the first submission the copy's script handles would create a certificate trigger on its own.
- [ ] Run `rotateSubmitSharedTokenAndLog()`. Put the `submitSharedToken` it logs into the staging site as `SUBMIT_SHARED_TOKEN`. (It changes the copy's tokens only, never production's.)
- [ ] Run `setupWorkerToken()`. Put the logged token into the staging site as `WORKER_TOKEN`.
- [ ] Set the Script Property `WORKER_API_URL` to `https://<staging>/.netlify/functions/worker`.
- [ ] **Deploy → New deployment → Web app** (Execute as me, Anyone). Put its `/exec` URL into the staging site as `GAS_WEB_APP_URL`.
- [ ] Deploy the staging site.
- [ ] Check it. This also confirms, from inside the site, that it reaches the database in a few milliseconds, which is the Singapore region at work:
  ```powershell
  node scripts/check-setup.mjs
  ```
  Skip the two connection strings, then give the staging address and its worker token.
- [ ] Try signing in on the staging site, with any password. Its database stays empty until the rehearsal's import, so the sign-in cannot succeed yet. But "Invalid email or password." proves Turnstile accepts the staging hostname, which the check cannot see; "Security verification expired or failed" means the hostname is missing.

Then run [Cutover](#cutover) on the copy and staging. Every "Apps Script" step means the copy's editor, and every "Netlify" step means the staging site. Skip "Staging off" and step 9: don't protect anything. Note the time each step took.

Afterwards, run [Rollback](#rollback) the same way. Finish by checking that the copy's Responses sheet holds the rehearsal's test submissions and that `auditChainDiagnose()` says "Chain is intact." Then delete the copy's `processCertificateQueue` trigger, and submit nothing more on staging.

The rehearsal passes when:
- the cutover runs start to finish in under 30 minutes;
- the timing script on staging ends with "Target … Met";
- the rollback ends with "Chain is intact" and nothing unexpected under `notCopied`.

Record the times and the timing results in the migration plan.

## Cutover

The day before:
- [ ] Run `exportForMigration()` and do a dry run (step 4, with `--dry-run`). It must end "Checks, all passed". If rows are listed, fix them in Sheets and repeat.
- [ ] Check production: run `node scripts/check-setup.mjs` and give the production address and its worker token. It should answer from Apps Script, and every setting the new backend needs should already be present.
- [ ] Have these open: Netlify environment variables, the Apps Script editor (**Executions** and **Triggers** pages), a terminal in this repository, and the password manager.

On the day, about 25 minutes. First, **staging off** (2 min), so nothing but production can reach the database the import fills:
- [ ] In the staging site, delete `SUPABASE_DB_URL` and deploy.
- [ ] In the spreadsheet copy, delete its `processCertificateQueue` trigger, if any.

1. **Maintenance on** (3 min)
   - [ ] Netlify: `MAINTENANCE_MODE=on`, then deploy.
   - [ ] Check: submitting the survey shows "The portal is being upgraded…", and a certificate's verification link still works.
2. **Stop the old queue** (2 min)
   - [ ] Apps Script **Executions**: wait until no `processCertificateQueue` run is in progress.
   - [ ] **Triggers**: delete the `processCertificateQueue` trigger.
3. **Export** (2 min)
   - [ ] Run `exportForMigration()` and download the file it logs into this folder. It is git-ignored.
4. **Import** (3 min). Put in the exported file's name. Each command asks for `AUDIT_HASH_SECRET` (from Script Properties); the second also asks for the session pooler string (from the password manager):
   ```powershell
   node scripts/import-sheets.mjs participant-feedback-export-….json --dry-run
   ```
   ```powershell
   node scripts/import-sheets.mjs participant-feedback-export-….json --replace --discard-new-data
   ```
   - [ ] Both end "Checks, all passed", and the second ends "Imported and committed."
   - [ ] Add `--skip-responses` only if every response in the sheet is a test.
   - [ ] `--discard-new-data` deletes what the rehearsal left in the database. Read what the command says it is replacing before you trust it.
5. **Switch** (3 min)
   - [ ] Netlify: `BACKEND=supabase`, remove `MAINTENANCE_MODE`, then deploy.
6. **New queue** (2 min). In Apps Script:
   - [ ] Script Property `CERTIFICATE_SOURCE=api`. `WORKER_API_URL` must be this site's `https://<site>/.netlify/functions/worker`.
   - [ ] Run `checkWorkerApi()`. It must say "Connected. Certificates are coming from the new backend."
   - [ ] Run `setupCertificateQueueTrigger()`.
7. **Prove it** (8 min)
   - [ ] Sign in to `/admin`. Everyone signs in again after cutover.
   - [ ] Create a test activity dated today, with the template and signatory of a real one.
   - [ ] Submit one response to it with your own email.
   - [ ] Within about 2 minutes the certificate email arrives, and its verification link shows it as valid.
   - [ ] End the test activity.
8. **Speed** (2 min)
   - [ ] Run `scripts/phase0-timings.js` in the browser console on `/admin`. It must end "Target … Met".
9. **Close the old sheets** (3 min)
   - [ ] In the spreadsheet, **Data → Protect sheets and ranges**: protect every sheet so that only you can edit. The rollback still writes as you.
   - [ ] Delete the export file from Drive, empty the trash, and delete the local copy.

If any step fails, stop and run [Rollback](#rollback).

## Rollback

Clean for the first 24 hours after cutover. After that, fix forward instead.

1. **Maintenance on** (3 min)
   - [ ] Netlify: `MAINTENANCE_MODE=on`, then deploy.
2. **Stop the new queue** (2 min)
   - [ ] Apps Script: wait until no `processCertificateQueue` run is in progress, then delete the trigger.
3. **Replay** (5 min)
   - [ ] Run `previewReplayFromNewBackend()` and read the log: how many responses, audit entries, activities and administrators it will copy, and `notCopied`.
   - [ ] Run `replayFromNewBackend()`. It must end with `auditChain: "Chain is intact."`
   - [ ] It refuses if the Audit sheet gained entries the new backend lacks: "the two have parted". That means the old portal was used after the export. Compare the two with `auditChainDiagnose()` before going further.
4. **Old queue** (2 min). In Apps Script:
   - [ ] Delete the Script Property `CERTIFICATE_SOURCE`.
   - [ ] Run `setupCertificateQueueTrigger()`.
5. **Switch back** (3 min)
   - [ ] Netlify: delete `BACKEND`, remove `MAINTENANCE_MODE`, then deploy.
6. **Afterwards**
   - [ ] Remove the sheet protection.
   - [ ] Redo by hand what `notCopied` listed, such as an administrator added after cutover or survey changes.
   - [ ] Everyone signs in again.

What the replay copies:
- **New responses**, with their certificate status, link and verification code, so certificates issued in the new portal still verify.
- **Status changes to imported responses.** A certificate a run was still making goes back to PENDING, and the old queue makes it. That participant may get the email twice, the same duplicate the plan accepts.
- **Audit entries**, continuing the chain.
- **Activities** created or changed.
- **Administrators'** name, role and active switch.
- **Question wording**, while the survey still has its 15 questions in order.

Running it twice copies nothing twice.

## A day after cutover

- [ ] Remove `MAINTENANCE_MODE` from production's variables if it is still there.
- [ ] Keep the protected sheets as the archive.
- [ ] Removing the Sheets code from Apps Script (the old queue, the replay) is the last step of the plan, once rollback is no longer an option.
