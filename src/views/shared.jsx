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

/**
 * Skeleton placeholder. Sized to the content it stands in for, so the layout
 * does not jump when real data arrives — a spinner cannot do that.
 */
export function Skeleton({ width = "100%", height = 12, radius = 6, style }) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Table-shaped skeleton matching a real row's two-line cell layout. */
export function SkeletonTable({ rows = 5, columns = 5 }) {
  return (
    <div className="skeleton-table" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="skeleton-row"
          // Track count follows the prop; a fixed grid in CSS would leave an
          // empty column whenever a table has fewer than five.
          style={{
            gridTemplateColumns: `1.6fr ${"1fr ".repeat(Math.max(0, columns - 1)).trim()}`,
          }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <div key={c}>
              <Skeleton width={c === 0 ? "72%" : "56%"} height={11} />
              {c === 0 && (
                <Skeleton
                  width="48%"
                  height={9}
                  style={{ marginTop: 6, opacity: 0.7 }}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Tooltip on hover and keyboard focus.
 *
 * The native `title` attribute is invisible to touch, appears only after a
 * long delay, and cannot be styled. This keeps `title` off the element so the
 * browser does not render both.
 */
export function Tooltip({ label, children, placement = "top", wrap = false }) {
  if (!label) return children;
  return (
    <span
      className={`tip tip-${placement}${wrap ? " tip-wrap" : ""}`}
      data-tip={label}
    >
      {children}
    </span>
  );
}
