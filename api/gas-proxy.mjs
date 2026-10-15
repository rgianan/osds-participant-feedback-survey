import { handler } from "../netlify/functions/gas-proxy.mjs";
import { runNetlifyFunction } from "./_netlify.mjs";

/** The browser-facing proxy on Vercel: the same function as Netlify's. */
export const GET = (request) => runNetlifyFunction(handler, request);
export const POST = (request) => runNetlifyFunction(handler, request);
