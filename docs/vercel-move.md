# Moving the portal from Netlify to Vercel

Vercel runs the portal's functions in Singapore (`sin1`), next to the database, which Netlify does only on its Pro plan. That takes each database round trip from about 210 ms to a few milliseconds.

**Plan:** Vercel's Hobby plan is limited to personal, non-commercial use. Check whether this portal fits it, or use Vercel Pro.

## What is already in place

The same repository deploys to both hosts, so the move needs no code change.

- `api/gas-proxy.mjs` and `api/worker.mjs` run the existing functions in `netlify/functions/`, through a small adapter (`api/_netlify.mjs`).
- `vercel.json` sets:
  - the build (`npm run build:vercel`);
  - Singapore as the region;
  - a 30-second maximum, above the portal's own limits (25 s for Apps Script, 20 s for the database);
  - the same security headers as `config/_headers`;
  - rewrites that keep the paths `/.netlify/functions/gas-proxy` and `/.netlify/functions/worker`.

  The browser and Apps Script use those paths unchanged, so only the site's address changes.
- `node scripts/check-setup.mjs` works against either host.
- **After the switch, the Netlify site stays as a redirect.** Every certificate already issued has a QR code with the Netlify address. On the old Netlify site, `REDIRECT_TO=https://<new address>` turns its next deploy into a permanent redirect of every path. Keep that site, on the free plan, for as long as those certificates matter.

Do the move in two steps: staging first, so the rehearsal runs in Singapore, then production's hosting on its own, while it still answers from Apps Script. The Supabase cutover comes after, on Vercel.

## 1. Staging on Vercel (about 20 minutes)

- [ ] **Add New → Project:** import the GitHub repository, and name it `ched-feedback-survey-staging`. Vercel detects Vite; `vercel.json` covers the rest.
- [ ] Before the first deploy, open **Environment Variables** on the import screen and add the staging values. The `VITE_` ones must be there when it builds.

  | Variable | Value |
  |---|---|
  | `BACKEND` | `supabase` |
  | `SUPABASE_DB_URL` | the `portal_api` string (transaction pooler) |
  | `PASSWORD_PEPPER`, `AUDIT_HASH_SECRET` | production's, from Script Properties |
  | `PORTAL_BASE_URL` | `https://ched-feedback-survey-staging.vercel.app` |
  | `GAS_WEB_APP_URL`, `SUBMIT_SHARED_TOKEN`, `WORKER_TOKEN` | the spreadsheet copy's, as on the Netlify staging site |
  | `TURNSTILE_SECRET_KEY` | as production |
  | `VITE_USE_NETLIFY_PROXY` | `true` |
  | `VITE_TURNSTILE_SITE_KEY` | as production |

  Mark the secrets **Sensitive**.
- [ ] In Cloudflare Turnstile, add `ched-feedback-survey-staging.vercel.app` to the widget's hostnames.
- [ ] In the spreadsheet copy, set `WORKER_API_URL` to `https://ched-feedback-survey-staging.vercel.app/.netlify/functions/worker`, then run `checkWorkerApi()`. It must say "Connected".
- [ ] Run `node scripts/check-setup.mjs` and give it the new address and the copy's worker token. The database round trip should now be a few milliseconds, not about 200.
- [ ] On the **Netlify** staging site, delete `SUPABASE_DB_URL` and deploy, so only one staging reaches the database. You can delete that site later.
- [ ] Carry on with the rehearsal on the Vercel address. The import is already in the database; continue from step 5.

## 2. Production's hosting on Vercel (about 20 minutes)

This moves the address only. Production keeps answering from Apps Script.

- [ ] **Add New → Project:** the same repository, named `ched-feedback-survey`. Its address becomes `https://ched-feedback-survey.vercel.app`; use it below, or yours if that name is taken. A domain of CHED's own, set under **Settings → Domains**, would make any future move free of redirects.
- [ ] Copy every variable from Netlify production, with `PORTAL_BASE_URL` set to the new address:
  - `GAS_WEB_APP_URL`, `SUBMIT_SHARED_TOKEN`, `TURNSTILE_SECRET_KEY`;
  - `VITE_USE_NETLIFY_PROXY`, `VITE_TURNSTILE_SITE_KEY`;
  - `SUPABASE_DB_URL`, `PASSWORD_PEPPER`, `AUDIT_HASH_SECRET`;
  - `WORKER_TOKEN`: production's own.

  Leave `BACKEND` unset.
- [ ] In Cloudflare Turnstile, add the new hostname.
- [ ] Run `node scripts/check-setup.mjs` against the new address. It should answer from Apps Script, with every setting present.
- [ ] Try the new address by hand:
  - the survey lists today's activities;
  - you can sign in to `/admin`;
  - a certificate's verification link works with `/verification?code=…`.
- [ ] **Switch:** on the **Netlify** production site, add `REDIRECT_TO` = `https://ched-feedback-survey.vercel.app` and deploy. Then open an old certificate's QR link: it should land on the new address and verify.
- [ ] In production's Apps Script, set `WORKER_API_URL` to `https://ched-feedback-survey.vercel.app/.netlify/functions/worker`, then run `checkWorkerApi()`.
- [ ] The Script Property `PORTAL_BASE_URL` updates by itself on the next request through the new address, because Code.gs remembers the address the proxy sends. Check it in Script Properties after a visit. New certificates then carry the new address.

## Reading the cutover checklist on Vercel

`docs/cutover-checklist.md` names Netlify's screens. On Vercel:

| The checklist says (Netlify) | On Vercel |
|---|---|
| Site configuration → Environment variables | Project → **Settings → Environment Variables** |
| Deploys → Trigger deploy → Deploy site | **Deployments** → the latest → ⋯ → **Redeploy**. Variables apply only to new deployments, as on Netlify |
| Clear cache and deploy site | Redeploy with **Use existing build cache** off |
| Logs → Functions → gas-proxy | Project → **Logs**, filtered by `/api/gas-proxy` |
| Functions region (Pro) | Already Singapore, set by `vercel.json` |

**Concurrency:** Vercel may serve several requests at once from one function instance. The portal keeps one database connection per instance, and its queries take their turn on it. In Singapore a query takes a few milliseconds, so this queueing goes unnoticed at the portal's traffic.
