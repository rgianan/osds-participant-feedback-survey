const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(payload),
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST")
    return json(405, { ok: false, error: "Method not allowed." });

  const gasUrl = String(
    process.env.GAS_WEB_APP_URL || process.env.VITE_GAS_WEB_APP_URL || "",
  ).trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl))
    return json(500, {
      ok: false,
      error:
        "The Apps Script backend is not configured. Set GAS_WEB_APP_URL in Netlify to the deployed /exec URL.",
    });
  const sharedToken = String(process.env.SUBMIT_SHARED_TOKEN || "").trim();
  if (sharedToken.length < 64)
    return json(500, {
      ok: false,
      error:
        "The submit security token is not configured. Set SUBMIT_SHARED_TOKEN in Netlify.",
    });

  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  if (!body || body.length > 6_000_000)
    return json(400, { ok: false, error: "Invalid request body." });

  try {
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return json(400, { ok: false, error: "Invalid JSON request." });
    payload.proxyToken = sharedToken;
    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const responseText = await upstream.text();
    try {
      JSON.parse(responseText);
    } catch {
      throw new Error(
        "Apps Script did not return JSON. Confirm the web app is deployed as Execute as me and accessible to Anyone.",
      );
    }
    return {
      statusCode: upstream.ok ? 200 : 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: responseText,
    };
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Unable to reach Apps Script: ${error.message || String(error)}`,
    });
  }
};
