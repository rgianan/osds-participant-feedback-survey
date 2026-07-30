import React, { useEffect, useRef } from "react";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

export function TurnstileWidget({ action, onToken, resetKey = 0 }) {
  const container = useRef(null),
    widgetId = useRef(null);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile) return;
      if (widgetId.current !== null) window.turnstile.remove(widgetId.current);
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action,
        theme: "light",
        size: "flexible",
        callback: onToken,
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector('script[data-ched-turnstile="true"]');
      if (!script) {
        script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.chedTurnstile = "true";
        document.head.appendChild(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      cancelled = true;
      if (widgetId.current !== null && window.turnstile)
        window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action, onToken, resetKey]);
  if (!TURNSTILE_SITE_KEY)
    return (
      <div className="alert">
        Turnstile is not configured. Add VITE_TURNSTILE_SITE_KEY in Netlify.
      </div>
    );
  return <div className="turnstile-wrap" ref={container} />;
}

export function Brand({ compact = false, admin = false }) {
  return (
    <div className="brand">
      <img
        className="brand-logo"
        src="https://ik.imagekit.io/k2qmtccm6/CHED_Logo_New.png"
        alt="Commission on Higher Education logo"
      />
      <div>
        {!compact && (
          <>
            <strong>
              {admin
                ? "Participant Feedback Certificate Portal"
                : "Commission on Higher Education"}
            </strong>
            <span>
              {admin ? "Admin Page" : "Participant Feedback Certificate Portal"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
