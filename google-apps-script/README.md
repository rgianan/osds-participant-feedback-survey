# Google Apps Script backend

This folder contains the optional Google Sheets, Drive, Slides, email, and certificate-generation backend used by the Netlify frontend.

Deploy `Code.gs` as a Google Apps Script web app, then configure Netlify with `GAS_WEB_APP_URL`, `SUBMIT_SHARED_TOKEN`, the Cloudflare Turnstile site/secret keys, and `PORTAL_BASE_URL`. Run `setupParticipantFeedbackSheets()` again to add the certificate-verification columns and tamper-evident `Audit` sheet safely. Audit access is restricted to the `superadmin` role.
