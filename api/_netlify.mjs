/**
 * Runs a Netlify-style function (netlify/functions/*.mjs) as a Vercel
 * function, so one codebase deploys to either host.
 *
 * Vercel hands a function a standard Request and expects a Response. The
 * functions here read Netlify's shape instead: { httpMethod, headers, body }
 * in, { statusCode, headers, body } out. This converts both ways and changes
 * nothing else. The body is passed on exactly as sent, whatever its
 * Content-Type: the browser sends text/plain, Apps Script application/json.
 *
 * vercel.json rewrites /.netlify/functions/<name> to /api/<name>, so the
 * browser and Apps Script use the same paths on both hosts. (Files in api/
 * whose name starts with "_", like this one, are not functions.)
 */
export async function runNetlifyFunction(handler, request) {
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const event = {
    httpMethod: request.method,
    headers: Object.fromEntries(request.headers), // already lower-case
    body: hasBody ? await request.text() : "",
    isBase64Encoded: false,
  };
  // Vercel's request ID, where Netlify's functions look for theirs.
  const context = { awsRequestId: request.headers.get("x-vercel-id") || "" };
  const reply = await handler(event, context);
  return new Response(reply.body ?? "", { status: reply.statusCode, headers: reply.headers || {} });
}
