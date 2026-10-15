import { handler } from "../netlify/functions/worker.mjs";
import { runNetlifyFunction } from "./_netlify.mjs";

/** The certificate worker's endpoint on Vercel: the same function as Netlify's. */
export const GET = (request) => runNetlifyFunction(handler, request);
export const POST = (request) => runNetlifyFunction(handler, request);
