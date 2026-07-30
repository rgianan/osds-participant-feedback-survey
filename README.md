# Participant Feedback & Certificate Portal

A React and Vite participant feedback survey with certificate generation. Its structure follows the attached Netlify portal: frontend views and shared libraries live under `src/`, while the Google Apps Script backend stays separate in `google-apps-script/`.

## Project structure

```text
public/                    Static public files
src/
  lib/api.js               Apps Script API client and preview data
  views/PortalViews.jsx    Public survey and admin dashboard
  App.jsx                  Application shell
  router.js                Public/admin route selection
  main.jsx                 React entry point
  style.css                Shared interface styles
google-apps-script/        Sheets, Drive, Slides, email, and certificate API
netlify.toml               Netlify build and SPA redirects
```

## Run locally

1. Run `npm install`.
2. Copy `.env.example` to `.env` and add the deployed Apps Script URL if available.
3. Run `npm run dev`.

Without an API URL, production mode fails closed. Local preview data is available only when `VITE_ENABLE_DEMO_MODE=true` is explicitly set.

## Routes

- `/` — participant survey and certificate confirmation
- `/admin` — activity, schedule, template, and certificate management

## Deploy to Netlify

Connect this repository to a new Netlify site. The included configuration automatically uses:

- Build command: `npm run build`
- Publish directory: `dist`
- SPA fallback: all routes redirect to `/index.html`

In **Site configuration → Environment variables**, add:

```text
GAS_WEB_APP_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
SUBMIT_SHARED_TOKEN=TOKEN_RETURNED_BY_SETUP_FUNCTION
TURNSTILE_SECRET_KEY=YOUR_CLOUDFLARE_TURNSTILE_SECRET_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_CLOUDFLARE_TURNSTILE_SITE_KEY
PORTAL_BASE_URL=https://YOUR-PRODUCTION-DOMAIN
```

The frontend uses a same-origin Netlify function to forward requests to Apps Script, avoiding browser cross-origin failures. Trigger a new deployment after changing the variable. A manual `dist/` upload does not include the server function and cannot connect to the production backend.

For secure local integration testing, use Netlify Dev and set `VITE_USE_NETLIFY_PROXY=true`. Direct Vite-to-Apps-Script requests do not receive the server-only shared token.

Do not set `VITE_ENABLE_DEMO_MODE` in Netlify. Demo mode is restricted to the local development server and must be explicitly enabled with `VITE_ENABLE_DEMO_MODE=true`.

Admin access uses email and password credentials stored as salted password hashes in a `Users` sheet. Edit the host account inside `seedUsers()` in `Code.gs`, replace its email and `CHANGE_THIS_PASSWORD`, then run the function once from the Apps Script editor. The seeded host has the `superadmin` role.

The superadmin can add and edit accounts in the admin **Users** page. Account metadata is synchronized to the `Whitelist` sheet using these headers: `user_id`, `name`, `role`, `email`, `active`, `created_at`, and `updated_at`. Password hashes and salts remain only in `Users`; passwords are never stored in `Whitelist`. The **Questions** page reads and updates `question1` through `question15` in row 2 of the `Questions` sheet. Both modules are enforced as superadmin-only by the Apps Script backend.

Create a Cloudflare Turnstile widget for the production portal hostname. Put its public site key in `VITE_TURNSTILE_SITE_KEY` and its secret key in `TURNSTILE_SECRET_KEY`. Participant submissions and admin logins are rejected by the Netlify proxy unless Cloudflare validates a fresh, single-use token for the expected action and hostname.

Production protections include expiring admin sessions, login throttling, upload-size and MIME validation, request-size limits, a participant-form honeypot, escaped certificate-email HTML, pinned package versions, and Netlify CSP/HSTS/security headers.

## Google Apps Script backend

Deploy `google-apps-script/Code.gs` as a web app and use its `/exec` URL in Netlify. Confirm the template and certificate folder IDs near the top of the script and authorize its Sheets, Drive, Slides, email, and user-information permissions.

For a new spreadsheet, run `setupParticipantFeedbackSheets()` once from the Apps Script editor. It creates the `Activity`, `Responses`, `Questions`, `Whitelist`, and `Users` sheets, adds any missing headers without deleting existing records, formats the header rows, and inserts the initial 15 editable survey questions. The function is safe to run again after future updates.

Run the setup function again after enabling certificate verification. It adds `Verification Code` and `Verification URL` to `Responses` without changing existing records. New submissions receive verification codes automatically; reprocessing an older response assigns it a code.

Certificate templates may include `{{VerificationCode}}`, `{{VerificationUrl}}`, and `{{QRCode}}`. Make `{{QRCode}}` its own text box sized to the QR image area. The generated QR code opens `/verification` with the certificate code prefilled.

After sheet setup, run `setupParticipantFeedbackSecurity()`. Copy its one-time `submitSharedToken` result into Netlify as `SUBMIT_SHARED_TOKEN`. Apps Script retains only the token hash; the separate session hashing secret remains in Script Properties. Then edit the host account inside `seedUsers()`, run `seedUsers()`, and run `setupCertificateQueueTrigger()`.

The queue setup function creates a one-minute processor trigger. Public submissions are written with `PENDING` status and return immediately; the trigger then creates certificates and sends their links through Google Workspace Mail in controlled batches.

Queue behavior:

- Processes up to 10 certificates per run
- Stops before the Apps Script execution-time limit
- Checks the remaining Google Workspace Mail quota before claiming work
- Keeps unclaimed records as `PENDING`
- Marks successful records `OK` and failed records `ERROR: ...`
- Retries temporary submission congestion from the Netlify client with exponential backoff

The spreadsheet should contain the `Activity`, `Questions`, `Responses`, and `Whitelist` sheets and the headers expected by `Code.gs`.
