import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileCheck2,
  LayoutDashboard,
  ListChecks,
  LogIn,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  adminLogin,
  adminLogout,
  deleteActivity,
  getActivities,
  getAdminActivities,
  getAdminQuestions,
  getAdminUsers,
  getFeedbackAnalytics,
  getQuestions,
  readAdminSession,
  saveActivity,
  saveAdminQuestions,
  saveAdminUser,
  submitFeedback,
  uploadSignature,
  verifyCertificate,
} from "../lib/api";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

function TurnstileWidget({ action, onToken, resetKey = 0 }) {
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

const emptyForm = {
  name: "",
  email: "",
  sex: "",
  age: "",
  activityId: "",
  activityTitle: "",
  venue: "",
  date: "",
  expectations: "",
  takeaways: "",
  suggestions: "",
};

function Brand({ compact = false, admin = false }) {
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
function Rating({ value, onChange, label }) {
  return (
    <fieldset className="rating">
      <legend>{label}</legend>
      <div className="rating-options">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            onClick={() => onChange(n)}
            className={value === n ? "selected" : ""}
            aria-label={`${n} out of 5`}
            title={`${n} out of 5 — ${["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"][n - 1]}`}
          >
            <span>{n}</span>
            <small>
              {
                [
                  "Strongly disagree",
                  "Disagree",
                  "Neutral",
                  "Agree",
                  "Strongly agree",
                ][n - 1]
              }
            </small>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PublicForm() {
  const [step, setStep] = useState(0),
    [form, setForm] = useState(emptyForm),
    [activities, setActivities] = useState([]),
    [questions, setQuestions] = useState([]),
    [ratings, setRatings] = useState({}),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(null),
    [error, setError] = useState(""),
    [turnstileToken, setTurnstileToken] = useState(""),
    [turnstileReset, setTurnstileReset] = useState(0);
  useEffect(() => {
    Promise.all([getActivities(), getQuestions()])
      .then(([a, q]) => {
        setActivities(a);
        setQuestions(q);
      })
      .catch((loadError) =>
        setError(loadError.message || "Unable to load the survey."),
      );
  }, []);
  const activity = activities.find((a) => a.id === form.activityId);
  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const valid = useMemo(
    () =>
      step === 0
        ? form.name.trim() &&
          /^\S+@\S+\.\S+$/.test(form.email) &&
          form.sex &&
          Number(form.age) >= 1 &&
          Number(form.age) <= 120 &&
          form.activityId
        : step === 1
          ? [0, 1, 2, 3, 4].every((i) => ratings[i])
          : step === 2
            ? [5, 6, 7, 8, 9].every((i) => ratings[i])
            : [10, 11, 12, 13, 14].every((i) => ratings[i]),
    [step, form, ratings],
  );
  async function next() {
    setError("");
    if (!valid) {
      setError("Please complete all required fields before continuing.");
      return;
    }
    if (step < 3) return setStep((s) => s + 1);
    if (!turnstileToken) {
      setError("Please complete the security verification before submitting.");
      return;
    }
    setBusy(true);
    try {
      const answers = Object.fromEntries(
        questions.map((_, i) => [`answer${i + 1}`, ratings[i]]),
      );
      const res = await submitFeedback(
        {
          ...form,
          title: activity?.title || "",
          venue: activity?.venue || "",
          activity_date: activity?.date || "",
          ...answers,
        },
        turnstileToken,
      );
      if (res.status === "BAD_REQUEST")
        throw new Error(res.message || "Please check your response.");
      if (res.status === "DUP")
        throw new Error(
          "A response for this activity already exists for this participant.",
        );
      setDone(res);
    } catch (e) {
      setError(e.message);
      setTurnstileToken("");
      setTurnstileReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <main className="success-page">
        <div className="success-card">
          <div className="success-icon">
            <Check />
          </div>
          <p className="eyebrow">Feedback received</p>
          <h1>Your certificate is in the queue.</h1>
          <p>
            Thank you, {form.name.split(" ")[0]}. We’ll generate your
            certificate for <strong>{activity?.title}</strong> and email the
            link to <strong>{form.email}</strong>.
          </p>
          <div className="success-actions">
            {done.certificateUrl && (
              <a
                className="button primary"
                href={done.certificateUrl}
                title="Open the generated certificate PDF"
              >
                <Download size={18} /> Open certificate
              </a>
            )}
            <button
              className="button secondary"
              title="Clear the completed response and start a new survey"
              onClick={() => {
                setDone(null);
                setStep(0);
                setForm(emptyForm);
                setRatings({});
                setTurnstileToken("");
                setTurnstileReset((value) => value + 1);
              }}
            >
              Submit another response
            </button>
          </div>
          <p className="tiny">
            During busy periods, processing may take several minutes. Check your
            spam folder if needed.
          </p>
        </div>
      </main>
    );
  const groups = [
    [0, 5],
    [5, 10],
    [10, 15],
  ][Math.max(0, step - 1)];
  return (
    <div>
      <header className="topbar">
        <Brand />
        <a
          className="verification-link"
          href="/verification"
          title="Verify an issued CHED certificate"
        >
          <BadgeCheck size={18} /> Verify certificate
        </a>
      </header>
      <main className="survey-shell">
        <section className="survey-intro">
          <p className="eyebrow">
            <Sparkles size={15} /> Learning experience
          </p>
          <h1>
            Help us make every
            <br />
            <em>activity better.</em>
          </h1>
          <p>
            Your thoughtful feedback helps improve future programs. Complete the
            short survey to receive your digital certificate.
          </p>
          <div className="privacy-note">
            <ShieldCheck />
            <div>
              <strong>Your response is confidential</strong>
              <span>It takes about 3–5 minutes to complete.</span>
            </div>
          </div>
        </section>
        <section className="survey-card">
          <div className="step-header">
            <span>Step {step + 1} of 4</span>
            <strong>
              {
                [
                  "About you",
                  "Program content",
                  "Event experience",
                  "Overall reflection",
                ][step]
              }
            </strong>
          </div>
          <div className="progress">
            <i style={{ width: `${(step + 1) * 25}%` }} />
          </div>
          <div className="form-body">
            {step === 0 ? (
              <>
                <div className="section-heading">
                  <span>01</span>
                  <div>
                    <h2>Let’s get to know you</h2>
                    <p>Tell us where to send your certificate.</p>
                  </div>
                </div>
                <label className="honeypot" aria-hidden="true">
                  Website
                  <input
                    tabIndex="-1"
                    autoComplete="off"
                    value={form.website}
                    onChange={(e) => update("website", e.target.value)}
                  />
                </label>
                <label>
                  Full name <b>*</b>
                  <input
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="e.g. Juan Dela Cruz"
                    autoComplete="name"
                  />
                </label>
                <label>
                  Email address <b>*</b>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => update("email", e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                  <small>
                    Google Workspace Mail will send your certificate to any
                    valid email domain.
                  </small>
                </label>
                <div className="demographic-grid">
                  <label>
                    Sex <b>*</b>
                    <div className="select-wrap">
                      <select
                        value={form.sex}
                        onChange={(e) => update("sex", e.target.value)}
                      >
                        <option value="">Select</option>
                        <option>Female</option>
                        <option>Male</option>
                        <option>Prefer not to say</option>
                      </select>
                      <ChevronDown />
                    </div>
                  </label>
                  <label>
                    Age <b>*</b>
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={form.age}
                      onChange={(e) => update("age", e.target.value)}
                      placeholder="Age"
                    />
                  </label>
                </div>
                <label>
                  Activity attended <b>*</b>
                  <div className="select-wrap">
                    <select
                      value={form.activityId}
                      onChange={(e) => update("activityId", e.target.value)}
                    >
                      <option value="">Select an activity</option>
                      {activities.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </label>
                {activity && (
                  <div className="activity-preview">
                    <FileCheck2 />
                    <div>
                      <strong>{activity.title}</strong>
                      <span>
                        {activity.date} · {activity.venue}
                      </span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="section-heading">
                  <span>0{step + 1}</span>
                  <div>
                    <h2>
                      {
                        [
                          "",
                          "Program content",
                          "Event experience",
                          "Overall reflection",
                        ][step]
                      }
                    </h2>
                    <p>
                      Select the response that best represents your experience.
                    </p>
                  </div>
                </div>
                {questions.slice(...groups).map((q, j) => {
                  const idx = groups[0] + j;
                  return (
                    <Rating
                      key={idx}
                      label={`${idx + 1}. ${q}`}
                      value={ratings[idx]}
                      onChange={(v) => setRatings((r) => ({ ...r, [idx]: v }))}
                    />
                  );
                })}
                {step === 3 && (
                  <>
                    <label>
                      What was your most valuable takeaway?
                      <textarea
                        value={form.takeaways}
                        onChange={(e) => update("takeaways", e.target.value)}
                        placeholder="Share your key learning..."
                      />
                    </label>
                    <label>
                      How can we improve future activities?
                      <textarea
                        value={form.suggestions}
                        onChange={(e) => update("suggestions", e.target.value)}
                        placeholder="Your suggestions are welcome..."
                      />
                    </label>
                    <TurnstileWidget
                      action="participant_submit"
                      onToken={setTurnstileToken}
                      resetKey={turnstileReset}
                    />
                  </>
                )}
              </>
            )}
            {error && <div className="alert">{error}</div>}
          </div>
          <footer className="form-footer">
            <button
              className="button ghost"
              title="Return to the previous survey step"
              disabled={step === 0}
              onClick={() => setStep((s) => s - 1)}
            >
              <ArrowLeft size={18} /> Back
            </button>
            <button
              className="button primary"
              disabled={busy || (step === 3 && !turnstileToken)}
              onClick={next}
              title={
                step === 3
                  ? "Submit your feedback for certificate processing"
                  : "Continue to the next survey step"
              }
            >
              {busy
                ? "Submitting…"
                : step === 3
                  ? "Submit feedback"
                  : "Continue"}{" "}
              {!busy &&
                (step === 3 ? <Check size={18} /> : <ArrowRight size={18} />)}
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}

export function VerificationPage() {
  const initialCode =
    new URLSearchParams(window.location.search).get("code") || "";
  const [code, setCode] = useState(initialCode.toUpperCase()),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function verify(event) {
    event?.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized)
      return setError(
        "Enter the verification code printed on the certificate.",
      );
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await verifyCertificate(normalized));
    } catch (verifyError) {
      setError(verifyError.message || "Unable to verify this certificate.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initialCode) verify();
  }, []);
  return (
    <div className="verification-page">
      <header className="topbar">
        <Brand />
        <a
          className="verification-link"
          href="/"
          title="Open the participant feedback portal"
        >
          <ArrowLeft size={18} /> Feedback portal
        </a>
      </header>
      <main className="verification-shell">
        <section className="verification-intro">
          <p className="eyebrow">
            <BadgeCheck size={15} /> Certificate validation
          </p>
          <h1>Verify a CHED certificate</h1>
          <p>
            Enter the code printed on the certificate, or scan its QR code, to
            confirm that it was issued through this portal.
          </p>
        </section>
        <form className="verification-card" onSubmit={verify}>
          <label>
            Certificate verification code{" "}
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="CHED-XXXXXXXXXXXXXXXXXXXX"
              autoComplete="off"
            />
          </label>
          <button
            className="button primary"
            disabled={busy}
            title="Check this certificate against the issuance registry"
          >
            <BadgeCheck size={18} /> {busy ? "Checking…" : "Verify certificate"}
          </button>
          {error && <div className="alert">{error}</div>}
          {result &&
            (result.valid ? (
              <article className="verification-result valid">
                <BadgeCheck />
                <div>
                  <span>Authentic certificate</span>
                  <h2>{result.name}</h2>
                  <dl>
                    <div>
                      <dt>Activity</dt>
                      <dd>{result.activity}</dd>
                    </div>
                    <div>
                      <dt>Activity date</dt>
                      <dd>{result.activityDate || "—"}</dd>
                    </div>
                    <div>
                      <dt>Venue</dt>
                      <dd>{result.venue || "—"}</dd>
                    </div>
                    <div>
                      <dt>Verification code</dt>
                      <dd>{result.verificationCode}</dd>
                    </div>
                  </dl>
                  {result.certificateUrl && (
                    <a
                      href={result.certificateUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the registered certificate PDF"
                    >
                      View registered PDF <ExternalLink size={15} />
                    </a>
                  )}
                </div>
              </article>
            ) : (
              <article className="verification-result invalid">
                <X />
                <div>
                  <span>Certificate not verified</span>
                  <p>
                    No issued certificate matches this code. Check the code
                    carefully or contact the activity organizer.
                  </p>
                </div>
              </article>
            ))}
        </form>
      </main>
    </div>
  );
}

function AdminLogin({ onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!turnstileToken)
        throw new Error("Please complete the security verification.");
      onAuthenticated(await adminLogin(email, password, turnstileToken));
    } catch (loginError) {
      setError(loginError.message || "Unable to sign in.");
      setTurnstileToken("");
      setTurnstileReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-login-page">
      <form className="admin-login-card" onSubmit={submit}>
        <Brand admin />
        <p className="eyebrow">
          <ShieldCheck size={15} /> Restricted access
        </p>
        <h1>Admin sign in</h1>
        <p>Use an administrator account created in Google Apps Script.</p>
        <label>
          Email address
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            placeholder="admin@example.com"
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
          />
        </label>
        <TurnstileWidget
          action="admin_login"
          onToken={setTurnstileToken}
          resetKey={turnstileReset}
        />
        {error && <div className="alert">{error}</div>}
        <button
          className="button primary login-submit"
          disabled={busy || !turnstileToken}
          title="Sign in to the protected admin module"
        >
          <LogIn size={18} /> {busy ? "Signing in…" : "Sign in"}
        </button>
        <a href="/" title="Return to the participant feedback form">
          Back to participant feedback
        </a>
      </form>
    </main>
  );
}

export function AdminDashboard() {
  const [rows, setRows] = useState([]),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState(false),
    [editing, setEditing] = useState(null),
    [toast, setToast] = useState(""),
    [tab, setTab] = useState("activities"),
    [analytics, setAnalytics] = useState(null),
    [activityFilter, setActivityFilter] = useState(""),
    [session, setSession] = useState(readAdminSession),
    [adminError, setAdminError] = useState("");
  const load = () => {
    setAdminError("");
    return Promise.all([getAdminActivities(), getFeedbackAnalytics()])
      .then(([activities, scores]) => {
        setRows(activities);
        setAnalytics(scores);
      })
      .catch((loadError) => {
        setAdminError(loadError.message || "Unable to load the admin module.");
        if (
          /session|expired|authorization|forbidden/i.test(
            loadError.message || "",
          )
        ) {
          adminLogout().finally(() => setSession(null));
        }
      });
  };
  useEffect(() => {
    if (session) load();
  }, [session]);
  useEffect(() => {
    if (session) {
      setAdminError("");
      getFeedbackAnalytics(activityFilter)
        .then(setAnalytics)
        .catch((error) => setAdminError(error.message));
    }
  }, [activityFilter, session]);
  const filtered = rows.filter((r) =>
    [r.title, r.venue, r.inCharge]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function remove(id) {
    if (!confirm("Delete this activity?")) return;
    setAdminError("");
    try {
      await deleteActivity(id);
      setRows((x) => x.filter((r) => r.id !== id));
      setToast("Activity deleted");
    } catch (deleteError) {
      setAdminError(deleteError.message || "Unable to delete the activity.");
    }
  }
  async function signOut() {
    await adminLogout();
    setSession(null);
  }
  if (!session) return <AdminLogin onAuthenticated={setSession} />;
  const isSuperadmin = session.user?.role?.toLowerCase() === "superadmin";
  const pageCopy = {
    activities: [
      "Activities",
      "Create activities, manage templates, and reuse signatory profiles.",
    ],
    analytics: [
      "Feedback analytics",
      "Understand participant scores and compare activities.",
    ],
    users: ["Users", "Create and maintain administrator access."],
    questions: [
      "Survey questions",
      "Edit the 15 participant rating questions.",
    ],
  }[tab] || ["Activities", "Manage the certificate portal."];
  return (
    <div className="admin-layout">
      <aside>
        <Brand admin />
        <nav>
          <button
            className={tab === "activities" ? "active" : ""}
            onClick={() => setTab("activities")}
            title="Manage activities, templates, and signatories"
          >
            <LayoutDashboard /> Activities
          </button>
          <button
            className={tab === "analytics" ? "active" : ""}
            onClick={() => setTab("analytics")}
            title="View participant feedback analytics"
          >
            <Sparkles /> Analytics
          </button>
          {isSuperadmin && (
            <button
              className={tab === "users" ? "active" : ""}
              onClick={() => setTab("users")}
              title="Add and manage administrator accounts"
            >
              <Users /> Users
            </button>
          )}
          {isSuperadmin && (
            <button
              className={tab === "questions" ? "active" : ""}
              onClick={() => setTab("questions")}
              title="Edit participant survey questions"
            >
              <ListChecks /> Questions
            </button>
          )}
          <a href="/" title="Open the participant feedback portal">
            <FileCheck2 /> Feedback portal
          </a>
        </nav>
        <div className="admin-profile">
          <span>
            {(session.user?.name || session.user?.email || "A")
              .split(/\s+/)
              .map((part) => part[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div>
            <strong>{session.user?.name || session.user?.email}</strong>
            <small>{session.user?.role || "Administrator"}</small>
          </div>
          <button
            className="profile-logout"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out of the admin module"
          >
            <LogOut />
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header>
          <div>
            <p className="eyebrow">Participant insights</p>
            <h1>{pageCopy[0]}</h1>
            <p>{pageCopy[1]}</p>
          </div>
          {tab === "activities" && (
            <button
              className="button primary"
              title="Create and configure a new activity"
              onClick={() => {
                setEditing(null);
                setModal(true);
              }}
            >
              <Plus /> New activity
            </button>
          )}
        </header>
        {adminError && <div className="alert admin-alert">{adminError}</div>}
        {tab === "analytics" ? (
          <AnalyticsPanel
            data={analytics}
            activities={rows}
            activityFilter={activityFilter}
            onFilter={setActivityFilter}
          />
        ) : tab === "users" && isSuperadmin ? (
          <UsersPanel />
        ) : tab === "questions" && isSuperadmin ? (
          <QuestionsPanel />
        ) : (
          <>
            <section className="stats">
              <article>
                <span>Active activities</span>
                <strong>{rows.length}</strong>
                <i className="green">
                  <FileCheck2 />
                </i>
              </article>
              <article>
                <span>Certificates issued</span>
                <strong>{analytics?.certificates?.issued || 0}</strong>
                <i className="gold">
                  <Download />
                </i>
              </article>
              <article>
                <span>Total responses</span>
                <strong>{analytics?.totalResponses || 0}</strong>
                <i className="blue">
                  <Sparkles />
                </i>
              </article>
            </section>
            <section className="table-card">
              <div className="table-tools">
                <div>
                  <h2>All activities</h2>
                  <p>{filtered.length} records</p>
                </div>
                <label className="search">
                  <Search />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search activities..."
                  />
                </label>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Activity</th>
                      <th>Region</th>
                      <th>Schedule</th>
                      <th>Venue</th>
                      <th>Signatory</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{r.title}</strong>
                          <small>{r.activityId || r.id}</small>
                        </td>
                        <td>{r.region || "—"}</td>
                        <td>{r.date || `${r.fromDate} – ${r.toDate}`}</td>
                        <td>{r.venue}</td>
                        <td>
                          {r.inCharge}
                          <small>{r.signatoryDesignation}</small>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              title={`Edit ${r.title}`}
                              onClick={() => {
                                setEditing(r);
                                setModal(true);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="danger"
                              aria-label={`Delete ${r.title}`}
                              title={`Delete ${r.title}`}
                              onClick={() => remove(r.id)}
                            >
                              <Trash2 />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
      {modal && (
        <ActivityModal
          activity={editing}
          activities={rows}
          onClose={() => setModal(false)}
          onSaved={() => {
            setModal(false);
            load();
            setToast("Activity saved");
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <Check /> {toast}
          <button onClick={() => setToast("")}>
            <X />
          </button>
        </div>
      )}
    </div>
  );
}

function UsersPanel() {
  const blank = {
    user_id: "",
    name: "",
    role: "admin",
    email: "",
    active: true,
    password: "",
  };
  const [users, setUsers] = useState([]),
    [form, setForm] = useState(blank),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false);
  const loadUsers = () =>
    getAdminUsers()
      .then(setUsers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    loadUsers();
  }, []);
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveAdminUser(form);
      setNotice(form.user_id ? "User updated." : "User added.");
      setForm(blank);
      await loadUsers();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="superadmin-grid">
      <form className="management-card user-form" onSubmit={save}>
        <div className="management-heading">
          <div>
            <h2>{form.user_id ? "Edit user" : "Add user"}</h2>
            <p>New users receive secure, hashed credentials.</p>
          </div>
          {form.user_id && (
            <button
              type="button"
              className="button ghost"
              title="Cancel editing"
              onClick={() => setForm(blank)}
            >
              Cancel
            </button>
          )}
        </div>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        <label>
          Name <b>*</b>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Full name"
          />
        </label>
        <label>
          Email <b>*</b>
          <input
            required
            type="email"
            disabled={Boolean(form.user_id)}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="name@yourdomain.gov.ph"
          />
        </label>
        <label>
          Role <b>*</b>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            <option value="admin">Admin</option>
            <option value="superadmin">Superadmin</option>
          </select>
        </label>
        <label>
          {form.user_id ? "New password (optional)" : "Temporary password *"}
          <input
            required={!form.user_id}
            minLength={12}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
          />
          <small>
            At least 12 characters. Passwords are never stored as plain text.
          </small>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />{" "}
          Active account
        </label>
        <button
          className="button primary"
          disabled={saving}
          title="Save this administrator account"
        >
          {saving ? "Saving…" : form.user_id ? "Update user" : "Add user"}
        </button>
      </form>
      <section className="management-card user-list">
        <div className="management-heading">
          <div>
            <h2>Whitelist users</h2>
            <p>{users.length} administrator accounts</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.user_id || user.email}>
                  <td>
                    <strong>{user.name}</strong>
                    <small>
                      {user.email}
                      <br />
                      {user.user_id}
                    </small>
                  </td>
                  <td>{user.role}</td>
                  <td>
                    <span
                      className={`status-pill ${user.active ? "enabled" : "disabled"}`}
                    >
                      {user.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{user.updated_at || user.created_at || "—"}</td>
                  <td>
                    <button
                      className="mini-button"
                      title={`Edit ${user.name}`}
                      onClick={() => setForm({ ...user, password: "" })}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function QuestionsPanel() {
  const [questions, setQuestions] = useState(Array(15).fill("")),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    getAdminQuestions()
      .then(setQuestions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      setQuestions(await saveAdminQuestions(questions));
      setMessage("Survey questions saved.");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }
  if (loading)
    return (
      <section className="analytics-loading">Loading survey questions…</section>
    );
  return (
    <form className="management-card questions-form" onSubmit={save}>
      <div className="management-heading">
        <div>
          <h2>Participant rating questions</h2>
          <p>
            Changes apply to new survey responses. The rating scale remains 1–5.
          </p>
        </div>
        <button
          className="button primary"
          disabled={saving}
          title="Save all survey questions"
        >
          {saving ? "Saving…" : "Save questions"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {message && <div className="notice">{message}</div>}
      <div className="question-editor">
        {questions.map((question, index) => (
          <label key={index}>
            <span>{index + 1}</span>
            <textarea
              required
              value={question}
              onChange={(e) =>
                setQuestions(
                  questions.map((item, i) =>
                    i === index ? e.target.value : item,
                  ),
                )
              }
              aria-label={`Question ${index + 1}`}
            />
          </label>
        ))}
      </div>
    </form>
  );
}

function AnalyticsPanel({ data, activities, activityFilter, onFilter }) {
  if (!data)
    return (
      <section className="analytics-loading">
        Loading participant scores…
      </section>
    );
  const max = Math.max(1, ...data.distribution),
    delta = Number(data.scoreDelta || 0);
  return (
    <>
      <div className="analytics-toolbar">
        <label>
          Activity
          <select
            value={activityFilter}
            onChange={(e) => onFilter(e.target.value)}
            title="Filter analytics by activity"
          >
            <option value="">All activities</option>
            {activities.map((a) => (
              <option key={a.activityId || a.id} value={a.activityId || a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <p>
          {activityFilter
            ? `Comparing selected activity with ${data.overallResponses || 0} responses overall`
            : "Showing consolidated results across every activity"}
        </p>
      </div>
      <section className="stats analytics-stats">
        <article>
          <span>Average score</span>
          <strong>
            {Number(data.averageScore).toFixed(2)}
            <small>/5</small>
          </strong>
          <em className={delta >= 0 ? "positive" : "negative"}>
            {activityFilter
              ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} vs overall`
              : "All activities"}
          </em>
        </article>
        <article>
          <span>Positive ratings</span>
          <strong>{Number(data.positiveRate || 0).toFixed(1)}%</strong>
          <em>Scores of 4 or 5</em>
        </article>
        <article>
          <span>Certificate issue rate</span>
          <strong>{Number(data.certificateIssueRate || 0).toFixed(1)}%</strong>
          <em>{data.certificates.issued} issued</em>
        </article>
        <article>
          <span>Complete scorecards</span>
          <strong>{data.completionRate}%</strong>
          <em>{data.totalResponses} responses</em>
        </article>
      </section>
      <section className="comparison-strip">
        <div>
          <span>Selected average</span>
          <strong>{Number(data.averageScore).toFixed(2)}</strong>
        </div>
        <i>
          <b style={{ width: `${(data.averageScore / 5) * 100}%` }} />
        </i>
        <div>
          <span>Overall average</span>
          <strong>
            {Number(data.overallAverage || data.averageScore).toFixed(2)}
          </strong>
        </div>
      </section>
      <section className="analytics-grid">
        <article className="chart-card">
          <header>
            <div>
              <h2>Score distribution</h2>
              <p>Answers across the 15 survey questions</p>
            </div>
          </header>
          <div
            className="distribution-chart"
            role="img"
            aria-label="Distribution of participant scores from one to five"
          >
            {data.distribution.map((count, index) => (
              <div className="distribution-column" key={index}>
                <strong>{count}</strong>
                <i style={{ height: `${Math.max(4, (count / max) * 100)}%` }} />
                <span>{index + 1} star</span>
              </div>
            ))}
          </div>
        </article>
        <article className="chart-card">
          <header>
            <div>
              <h2>Certificate pipeline</h2>
              <p>Status for the selected scope</p>
            </div>
          </header>
          <div className="pipeline-list">
            {[
              ["Queued", data.certificates.queued],
              ["Processing", data.certificates.processing],
              ["Issued", data.certificates.issued],
              ["Failed", data.certificates.failed],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </article>
        <article className="chart-card question-chart">
          <header>
            <div>
              <h2>Question performance</h2>
              <p>Average rating by survey question</p>
            </div>
          </header>
          <div className="question-bars">
            {data.questions.map((question, index) => (
              <div key={index}>
                <span>Q{index + 1}</span>
                <i>
                  <b style={{ width: `${(question.average / 5) * 100}%` }} />
                </i>
                <strong>{Number(question.average).toFixed(2)}</strong>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

const REGIONS = [
  "NCR",
  "CAR",
  "Region 1",
  "Region 2",
  "Region 3",
  "Region 4A",
  "MIMAROPA",
  "Region 5",
  "Region 6",
  "Region 7",
  "Region 8",
  "Region 9",
  "Region 10",
  "Region 11",
  "Region 12",
  "Region 13",
];
function ActivityModal({ activity, activities, onClose, onSaved }) {
  const empty = {
    title: "",
    region: "",
    venue: "",
    fromDate: "",
    toDate: "",
    givenDate: "",
    inCharge: "",
    signatoryDesignation: "",
    signature: "",
    template: "",
  };
  const [form, setForm] = useState(activity || empty),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const profiles = Array.from(
    new Map(
      activities
        .filter((a) => a.inCharge)
        .map((a) => [
          `${a.inCharge}|${a.signatoryDesignation}|${a.signature}`,
          a,
        ]),
    ).values(),
  );
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const chooseProfile = (value) => {
    const p = profiles.find(
      (x) => `${x.inCharge}|${x.signatoryDesignation}|${x.signature}` === value,
    );
    if (p)
      setForm((f) => ({
        ...f,
        inCharge: p.inCharge,
        signatoryDesignation: p.signatoryDesignation,
        signature: p.signature,
      }));
  };
  async function signatureFile(file) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const uploaded = await uploadSignature(file);
      set("signature", uploaded.url);
    } catch (uploadError) {
      setError(uploadError.message || "Unable to upload the e-signature.");
    } finally {
      setUploading(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await saveActivity(form);
      onSaved();
    } catch (saveError) {
      setError(saveError.message || "Unable to save the activity.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <header>
          <div>
            <p className="eyebrow">Activity details</p>
            <h2>{activity ? "Edit activity" : "Create a new activity"}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close activity details"
            title="Close without saving"
          >
            <X />
          </button>
        </header>
        {error && <div className="alert modal-alert">{error}</div>}
        <div className="modal-body">
          <label className="full">
            Activity title <b>*</b>
            <input
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Enter the official activity title"
            />
          </label>
          <label>
            Region <b>*</b>
            <select
              required
              value={form.region}
              onChange={(e) => set("region", e.target.value)}
            >
              <option value="">Select region</option>
              {REGIONS.map((region) => (
                <option key={region}>{region}</option>
              ))}
            </select>
          </label>
          <label>
            Venue <b>*</b>
            <input
              required
              value={form.venue}
              onChange={(e) => set("venue", e.target.value)}
              placeholder="Venue or online platform"
            />
          </label>
          <label>
            Start date <b>*</b>
            <input
              required
              type="date"
              value={form.fromDate}
              onChange={(e) => set("fromDate", e.target.value)}
            />
          </label>
          <label>
            End date <b>*</b>
            <input
              required
              type="date"
              value={form.toDate}
              onChange={(e) => set("toDate", e.target.value)}
            />
          </label>
          <label>
            Certificate date <b>*</b>
            <input
              required
              type="date"
              value={form.givenDate}
              onChange={(e) => set("givenDate", e.target.value)}
            />
          </label>
          <label>
            Reuse signatory profile
            <select
              defaultValue=""
              title="Reuse the name, designation, and signature from a previous activity"
              onChange={(e) => chooseProfile(e.target.value)}
            >
              <option value="">Choose a previous signatory</option>
              {profiles.map((p) => (
                <option
                  key={`${p.inCharge}|${p.signature}`}
                  value={`${p.inCharge}|${p.signatoryDesignation}|${p.signature}`}
                >
                  {p.inCharge} — {p.signatoryDesignation}
                </option>
              ))}
            </select>
          </label>
          <label>
            Signatory name <b>*</b>
            <input
              required
              value={form.inCharge}
              onChange={(e) => set("inCharge", e.target.value)}
              placeholder="Full name"
            />
          </label>
          <label>
            Signatory designation <b>*</b>
            <input
              required
              value={form.signatoryDesignation}
              onChange={(e) => set("signatoryDesignation", e.target.value)}
              placeholder="e.g. Regional Director"
            />
          </label>
          <label className="full">
            E-signature image <b>*</b>
            <div className="upload">
              <Upload />
              <div>
                <strong>
                  {uploading
                    ? "Uploading…"
                    : form.signature
                      ? "E-signature ready"
                      : "Upload transparent PNG or JPG"}
                </strong>
                <span>
                  The same signatory can be reused in future activities.
                </span>
              </div>
              <input
                type="file"
                title="Upload a PNG, JPG, or WebP e-signature image"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => signatureFile(e.target.files[0])}
              />
            </div>
          </label>
          <label className="full">
            Certificate template <b>*</b>
            <input
              required
              value={form.template}
              onChange={(e) => set("template", e.target.value)}
              placeholder="Google Drive template URL or file ID"
            />
            <small>
              Use {"{{Signatory}}"}, {"{{Designation}}"}, and {"{{Signature}}"}{" "}
              in the Slides template.
            </small>
          </label>
        </div>
        <footer>
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            title="Cancel changes and close"
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || uploading}
            title="Save the activity details"
          >
            {busy ? "Saving…" : "Save activity"}
          </button>
        </footer>
      </form>
    </div>
  );
}
