import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileCheck2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  getActivities,
  getQuestions,
  submitFeedback,
  verifyCertificate,
} from "../lib/api";
import { Brand, TurnstileWidget } from "./shared";

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
    [turnstileReset, setTurnstileReset] = useState(0),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    Promise.all([getActivities(), getQuestions()])
      .then(([a, q]) => {
        setActivities(a);
        setQuestions(q);
        setLoaded(true);
      })
      .catch((loadError) =>
        setError(loadError.message || "Unable to load the survey."),
      );
  }, []);
  const activity = activities.find((a) => a.id === form.activityId);
  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // A rating answer is 1-5; a long-text answer is any non-blank string.
  const answered = (i) => String(ratings[i] ?? "").trim() !== "";
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
          ? [0, 1, 2, 3, 4].every(answered)
          : step === 2
            ? [5, 6, 7, 8, 9].every(answered)
            : [10, 11, 12, 13, 14].every(answered),
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
      if (res.status === "CLOSED") {
        // The activity closed, or its dates passed, while this form was open.
        setActivities((list) => list.filter((a) => a.id !== form.activityId));
        setForm((f) => ({ ...f, activityId: "" }));
        setStep(0);
        throw new Error(
          res.message || "This activity is no longer accepting feedback.",
        );
      }
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
                  {loaded && !activities.length && (
                    <small>
                      No activity is open for feedback today. The form opens on
                      the activity dates set by the organizer.
                    </small>
                  )}
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
                      Answer every question below before continuing.
                    </p>
                  </div>
                </div>
                {questions.slice(...groups).map((q, j) => {
                  const idx = groups[0] + j;
                  if (q.type === "text")
                    return (
                      <label key={idx} className="question-text">
                        {`${idx + 1}. ${q.text}`}
                        <textarea
                          value={ratings[idx] ?? ""}
                          maxLength={2000}
                          placeholder="Type your answer"
                          onChange={(e) =>
                            setRatings((r) => ({ ...r, [idx]: e.target.value }))
                          }
                        />
                      </label>
                    );
                  return (
                    <Rating
                      key={idx}
                      label={`${idx + 1}. ${q.text}`}
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

