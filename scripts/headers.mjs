/**
 * Production security headers are kept in config/_headers and copied into
 * dist/ only at build time.
 *
 * Why not public/_headers or a netlify.toml [[headers]] block: `netlify dev`
 * applies whichever it finds, including the copy inside dist/. The CSP's
 * script-src then blocks Vite's inline React Refresh preamble, every React
 * module throws "can't detect preamble", and the app renders a blank page with
 * no console error. Keeping the file out of both locations during development
 * is the only reliable separation.
 *
 *   node scripts/headers.mjs emit   → copy config/_headers to dist/_headers
 *   node scripts/headers.mjs clean  → delete dist/_headers before `netlify dev`
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "config", "_headers");
const target = join(root, "dist", "_headers");
const mode = process.argv[2];

// `netlify dev` serves dist/_headers even when it proxies to Vite, and it
// re-reads the file, so a local `npm run build` mid-session would blank the
// dev server. Emit only on real deploy builds (Netlify and CI set these), or
// when forced via `npm run build:prod`.
const isDeployBuild =
  process.env.NETLIFY === "true" || process.env.CI === "true";
const forced = process.argv.includes("--force");

if (mode === "emit") {
  if (!existsSync(source)) {
    console.error(`headers: missing ${source} — production would deploy with no CSP.`);
    process.exit(1);
  }
  if (!isDeployBuild && !forced) {
    console.log(
      "headers: local build — skipped dist/_headers so `netlify dev` keeps working. Use `npm run build:prod` to include it.",
    );
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log("headers: wrote dist/_headers");
  }
} else if (mode === "clean") {
  rmSync(target, { force: true });
  console.log("headers: removed dist/_headers for local development");
} else {
  console.error("headers: expected 'emit' or 'clean'");
  process.exit(1);
}
