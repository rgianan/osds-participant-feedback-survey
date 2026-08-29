import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardList,
  Download,
  FileCheck2,
  LayoutDashboard,
  ListChecks,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
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
  setActivityStatus,
  getAdminDashboard,
  getAdminResponses,
  getCertificateQueue,
  retryCertificates,
  getAdminAuditLog,
  getAdminQuestions,
  getAdminUsers,
  getFeedbackAnalytics,
  readAdminSession,
  saveActivity,
  saveAdminQuestions,
  saveAdminUser,
  uploadSignature,
} from "../lib/api";
import { Brand, Skeleton, SkeletonTable, Tooltip, TurnstileWidget } from "./shared";

const NOT_OWNER_HINT =
  "Only the administrator who created this activity, or a superadmin, can edit, end, or delete it.";

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
  const load = (force = false) => {
    setAdminError("");
    // One request instead of two: each round trip is a Netlify hop plus its
    // own Apps Script execution, and the dashboard always needs both halves.
    return getAdminDashboard({ activityId: "" }, { force })
      .then(({ activities, analytics: scores }) => {
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
    // Skip the unfiltered case: the dashboard request already returned it.
    if (!session || !activityFilter) return;
    setAdminError("");
    getFeedbackAnalytics(activityFilter)
      .then(setAnalytics)
      .catch((error) => setAdminError(error.message));
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
    const previous = rows;
    setRows((x) => x.filter((r) => r.id !== id));
    try {
      await deleteActivity(id);
      setToast("Activity deleted");
    } catch (deleteError) {
      setRows(previous); // put it back: the server rejected the delete
      setAdminError(deleteError.message || "Unable to delete the activity.");
    }
  }
  async function toggleActive(row) {
    if (row.pending) return; // a toggle is already in flight for this row
    const next = !row.active;
    if (
      !next &&
      !confirm(
        `End "${row.title}"?\n\nThe feedback form will hide it and certificate generation will stop. Queued responses resume if you reopen it.`,
      )
    )
      return;
    setAdminError("");
    // Optimistic: the row flips immediately and reverts if the call fails.
    // A round trip here is 2-4s, which otherwise feels like a dead click.
    const revert = () =>
      setRows((x) =>
        x.map((r) =>
          r.id === row.id ? { ...r, active: row.active, pending: false } : r,
        ),
      );
    setRows((x) =>
      x.map((r) => (r.id === row.id ? { ...r, active: next, pending: true } : r)),
    );
    try {
      await setActivityStatus(row.id, next);
      setRows((x) =>
        x.map((r) => (r.id === row.id ? { ...r, active: next, pending: false } : r)),
      );
      setToast(next ? "Activity reopened" : "Activity ended");
    } catch (statusError) {
      revert();
      setAdminError(
        statusError.message || "Unable to change the activity status.",
      );
    }
  }
  async function signOut() {
    try {
      await adminLogout();
    } finally {
      setSession(null);
    }
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
    responses: [
      "Participant responses",
      "Browse every submitted response and filter by activity.",
    ],
    certificates: [
      "Certificates",
      "Track generation, see why one failed, and re-queue it.",
    ],
    users: ["Users", "Create and maintain administrator access."],
    questions: [
      "Survey questions",
      "Edit the 15 participant questions and their answer types.",
    ],
    audit: ["Audit log", "Review administrator access and privileged changes."],
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
          <button
            className={tab === "responses" ? "active" : ""}
            onClick={() => setTab("responses")}
            title="Browse participant responses, filtered by activity"
          >
            <ClipboardList /> Responses
          </button>
          <button
            className={tab === "certificates" ? "active" : ""}
            onClick={() => setTab("certificates")}
            title="Review and retry certificate generation"
          >
            <FileCheck2 /> Certificates
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
          {isSuperadmin && (
            <button
              className={tab === "audit" ? "active" : ""}
              onClick={() => setTab("audit")}
              title="Review the protected administrator audit trail"
            >
              <ClipboardList /> Audit
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
        ) : tab === "responses" ? (
          <ResponsesPanel activities={rows} />
        ) : tab === "certificates" ? (
          <CertificatesPanel activities={rows} />
        ) : tab === "users" && isSuperadmin ? (
          <UsersPanel />
        ) : tab === "questions" && isSuperadmin ? (
          <QuestionsPanel />
        ) : tab === "audit" && isSuperadmin ? (
          <AuditPanel />
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
                      <th>Feedback</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {!analytics && !rows.length && (
                      <tr>
                        <td colSpan={7} className="skeleton-cell">
                          <SkeletonTable rows={4} columns={6} />
                        </td>
                      </tr>
                    )}
                    {analytics && !filtered.length && (
                      <tr>
                        <td colSpan={7} className="empty-cell">
                          {query
                            ? "No activities match your search."
                            : "No activities yet. Create one to start collecting feedback."}
                        </td>
                      </tr>
                    )}
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
                          <span
                            className={`badge${r.active ? "" : " badge-off"}`}
                            title={
                              r.active
                                ? r.windowOpen
                                  ? "Open: participants can submit feedback now."
                                  : "Switched on, but today is outside the activity dates."
                                : "Closed: hidden from participants and certificate generation is stopped."
                            }
                          >
                            {!r.active
                              ? "Closed"
                              : r.windowOpen
                                ? "Open"
                                : "Scheduled"}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <Tooltip
                              wrap={!r.canManage}
                              label={
                                r.canManage
                                  ? r.active
                                    ? "Stop collecting feedback and pause certificates"
                                    : "Reopen and release held certificates"
                                  : NOT_OWNER_HINT
                              }
                            >
                              <button
                                disabled={!r.canManage || r.pending}
                                onClick={() => toggleActive(r)}
                              >
                                {r.active ? "End" : "Reopen"}
                              </button>
                            </Tooltip>
                            <Tooltip
                              wrap={!r.canManage}
                              label={
                                r.canManage
                                  ? "Edit activity details"
                                  : NOT_OWNER_HINT
                              }
                            >
                              <button
                                disabled={!r.canManage}
                                onClick={() => {
                                  setEditing(r);
                                  setModal(true);
                                }}
                              >
                                Edit
                              </button>
                            </Tooltip>
                            <Tooltip
                              wrap={!r.canManage}
                              label={
                                r.canManage
                                  ? "Delete this activity permanently"
                                  : NOT_OWNER_HINT
                              }
                            >
                            <button
                              className="danger"
                              disabled={!r.canManage}
                              aria-label={`Delete ${r.title}`}
                              onClick={() => remove(r.id)}
                            >
                              <Trash2 />
                            </button>
                            </Tooltip>
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

function ResponsesPanel({ activities }) {
  const [data, setData] = useState(null),
    [activityId, setActivityId] = useState(""),
    [query, setQuery] = useState(""),
    [expanded, setExpanded] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");

  const load = (force = false) => {
    setLoading(true);
    setError("");
    return getAdminResponses({ activityId, query }, { force })
      .then(setData)
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  };
  // Refetch on activity change; the text query is applied on submit so every
  // keystroke does not become an Apps Script round trip.
  useEffect(() => {
    load();
  }, [activityId]);

  const entries = data?.entries || [];
  return (
    <section className="management-card">
      <div className="management-heading">
        <div>
          <h2>Participant responses</h2>
          {loading && !data ? (
            <Skeleton width={130} height={11} style={{ marginTop: 6 }} />
          ) : (
            <p>
              {`${entries.length} shown${data?.total > entries.length ? ` of ${data.total}` : ""}`}
              {loading ? " · refreshing…" : ""}
            </p>
          )}
        </div>
        <div className="panel-tools">
          <div className="select-wrap">
            <select
              value={activityId}
              onChange={(e) => setActivityId(e.target.value)}
              title="Filter responses by activity"
            >
              <option value="">All activities</option>
              {activities.map((a) => (
                <option key={a.id} value={a.activityId || a.id}>
                  {a.title}
                </option>
              ))}
            </select>
            <ChevronDown />
          </div>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              load();
            }}
          >
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, email, activity…"
              aria-label="Search responses"
            />
          </form>
          <button
            className="mini-button"
            onClick={() => load(true)}
            disabled={loading}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Participant</th>
              <th>Activity</th>
              <th>Submitted</th>
              <th>Avg</th>
              <th>Certificate</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr>
                <td colSpan={6} className="skeleton-cell">
                  <SkeletonTable rows={6} columns={5} />
                </td>
              </tr>
            )}
            {!loading && !entries.length && (
              <tr>
                <td colSpan={6} className="empty-cell">
                  No responses match this filter.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <React.Fragment key={entry.row}>
                <tr>
                  <td>
                    <strong>{entry.name || "—"}</strong>
                    <small>{entry.email}</small>
                  </td>
                  <td>
                    {entry.title || "—"}
                    <small>{entry.activityDate}</small>
                  </td>
                  <td>{entry.submittedAt || "—"}</td>
                  <td>{entry.averageRating ? entry.averageRating : "—"}</td>
                  <td>
                    <span
                      className={`badge state-${entry.certificateState.toLowerCase()}`}
                      title={entry.certificateError || entry.certificateState}
                    >
                      {entry.certificateState}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="mini-button"
                        onClick={() =>
                          setExpanded(expanded === entry.row ? null : entry.row)
                        }
                        title="Show this participant's answers"
                      >
                        {expanded === entry.row ? "Hide" : "Answers"}
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === entry.row && (
                  <tr className="detail-row">
                    <td colSpan={6}>
                      <div className="answer-grid">
                        {entry.answers.map((answer) => (
                          <div key={answer.number}>
                            <span>Q{answer.number}</span>
                            <strong>{answer.value || "—"}</strong>
                          </div>
                        ))}
                      </div>
                      {(entry.takeaways || entry.suggestions) && (
                        <div className="answer-notes">
                          {entry.takeaways && (
                            <p>
                              <b>Takeaway:</b> {entry.takeaways}
                            </p>
                          )}
                          {entry.suggestions && (
                            <p>
                              <b>Suggestion:</b> {entry.suggestions}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const CERTIFICATE_TABS = [
  ["FAILED", "Failed", "Generation failed — retry after fixing the cause"],
  ["QUEUED", "Awaiting release", "Waiting for the queue to pick them up"],
  ["ISSUED", "Issued", "Generated and emailed to the participant"],
];

function CertificatesPanel({ activities }) {
  const [state, setState] = useState("FAILED"),
    [activityId, setActivityId] = useState(""),
    [data, setData] = useState(null),
    [selected, setSelected] = useState([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");

  const load = (force = false) => {
    setLoading(true);
    setError("");
    setSelected([]);
    return getCertificateQueue({ state, activityId }, { force })
      .then(setData)
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [state, activityId]);

  const entries = data?.entries || [];
  const counts = data?.counts || {};
  const toggle = (row) =>
    setSelected((rows) =>
      rows.includes(row) ? rows.filter((r) => r !== row) : [...rows, row],
    );

  async function retry(rows) {
    if (!rows.length) return;
    setBusy(true);
    setMessage("");
    setError("");
    // Optimistic: pull the rows out of the Failed list immediately. They move
    // to Awaiting release, which is where they genuinely are once re-queued.
    const previous = data;
    setData((current) =>
      current
        ? {
            ...current,
            entries: current.entries.filter((e) => !rows.includes(e.row)),
            counts: {
              ...current.counts,
              FAILED: Math.max(0, (current.counts?.FAILED || 0) - rows.length),
              QUEUED: (current.counts?.QUEUED || 0) + rows.length,
            },
          }
        : current,
    );
    setSelected([]);
    try {
      const result = await retryCertificates(rows);
      setMessage(
        `${result.requeued} certificate${result.requeued === 1 ? "" : "s"} re-queued. The generator picks them up within a minute.`,
      );
      await load(true);
    } catch (retryError) {
      setData(previous); // the retry failed; put the rows back
      setError(retryError.message || "Unable to retry these certificates.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-card">
      <div className="management-heading">
        <div>
          <h2>Certificate generation</h2>
          <p>Review what failed, fix the cause, then re-queue it.</p>
        </div>
        <div className="panel-tools">
          <div className="select-wrap">
            <select
              value={activityId}
              onChange={(e) => setActivityId(e.target.value)}
              title="Filter by activity"
            >
              <option value="">All activities</option>
              {activities.map((a) => (
                <option key={a.id} value={a.activityId || a.id}>
                  {a.title}
                </option>
              ))}
            </select>
            <ChevronDown />
          </div>
          <button
            className="mini-button"
            onClick={() => load(true)}
            disabled={loading}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="queue-tabs">
        {CERTIFICATE_TABS.map(([key, label, hint]) => (
          <button
            key={key}
            className={state === key ? "active" : ""}
            onClick={() => setState(key)}
            title={hint}
          >
            {label}
            <i>{counts[key] ?? 0}</i>
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {!!data?.heldActivities?.length && (
        <div className="notice">
          Held because their activity is ended:{" "}
          {data.heldActivities.join(", ")}. Reopen the activity to release them.
        </div>
      )}

      {state === "FAILED" && entries.length > 0 && (
        <div className="queue-bulk">
          <button
            className="button primary"
            disabled={busy || !selected.length}
            onClick={() => retry(selected)}
            title="Re-queue the selected certificates"
          >
            <RefreshCw size={16} />
            {busy
              ? "Re-queueing…"
              : `Retry selected${selected.length ? ` (${selected.length})` : ""}`}
          </button>
          <button
            className="mini-button"
            disabled={busy}
            onClick={() => retry(entries.map((e) => e.row))}
            title="Re-queue every failed certificate shown"
          >
            Retry all {entries.length}
          </button>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {state === "FAILED" && <th className="tick-col"></th>}
              <th>Participant</th>
              <th>Activity</th>
              <th>Submitted</th>
              <th>{state === "FAILED" ? "Reason" : "Status"}</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr>
                <td
                  colSpan={state === "FAILED" ? 5 : 4}
                  className="skeleton-cell"
                >
                  <SkeletonTable rows={4} columns={4} />
                </td>
              </tr>
            )}
            {!loading && !entries.length && (
              <tr>
                <td
                  colSpan={state === "FAILED" ? 5 : 4}
                  className="empty-cell"
                >
                  No certificate requests with this status.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.row}>
                {state === "FAILED" && (
                  <td className="tick-col">
                    <input
                      type="checkbox"
                      checked={selected.includes(entry.row)}
                      onChange={() => toggle(entry.row)}
                      aria-label={`Select ${entry.name} for retry`}
                    />
                  </td>
                )}
                <td>
                  <strong>{entry.name || "—"}</strong>
                  <small>{entry.email}</small>
                </td>
                <td>
                  {entry.title || "—"}
                  <small>{entry.activityDate}</small>
                </td>
                <td>{entry.submittedAt || "—"}</td>
                <td>
                  {state === "FAILED" ? (
                    <span className="queue-error" title={entry.error}>
                      {entry.error || "Unknown error"}
                    </span>
                  ) : (
                    <span
                      className={`badge state-${entry.state.toLowerCase()}`}
                      title={entry.held ? "Held: the activity is ended" : ""}
                    >
                      {entry.held ? "HELD" : entry.state}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
    [saving, setSaving] = useState(false),
    [loading, setLoading] = useState(true);
  const loadUsers = () => {
    setLoading(true);
    return getAdminUsers()
      .then(setUsers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
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
              {loading && !users.length && (
                <tr>
                  <td colSpan={5} className="skeleton-cell">
                    <SkeletonTable rows={3} columns={4} />
                  </td>
                </tr>
              )}
              {!loading && !users.length && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    No administrator accounts yet.
                  </td>
                </tr>
              )}
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
  const [questions, setQuestions] = useState(
    Array.from({ length: 15 }, () => ({ text: "", type: "rating" })),
  ),
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
      <section className="management-card" role="status" aria-label="Loading questions">
        <Skeleton width={210} height={14} />
        <div className="question-editor" style={{ marginTop: 20 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="question-row">
              <Skeleton width={30} height={30} radius={9} />
              <div style={{ display: "grid", gap: 10 }}>
                <Skeleton width="100%" height={54} radius={10} />
                <Skeleton width="42%" height={30} radius={10} />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  return (
    <form className="management-card questions-form" onSubmit={save}>
      <div className="management-heading">
        <div>
          <h2>Participant survey questions</h2>
          <p>
            Changes apply to new survey responses. Choose an answer type per
            question: a 1–5 multiple option, or a long text reply.
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
        {questions.map((question, index) => {
          const patch = (changes) =>
            setQuestions(
              questions.map((item, i) =>
                i === index ? { ...item, ...changes } : item,
              ),
            );
          return (
            <div className="question-row" key={index}>
              <span className="question-number">{index + 1}</span>
              <div className="question-fields">
                <label>
                  Question {index + 1}
                  <textarea
                    required
                    value={question.text}
                    onChange={(e) => patch({ text: e.target.value })}
                  />
                </label>
                <label>
                  Answer type
                  <select
                    className="question-type"
                    value={question.type}
                    onChange={(e) => patch({ type: e.target.value })}
                    title="How participants answer this question."
                  >
                    <option value="rating">Multiple option (1–5)</option>
                    <option value="yesno">Yes or No</option>
                    <option value="text">Long text</option>
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </form>
  );
}

function AuditPanel() {
  const [data, setData] = useState(null),
    [filters, setFilters] = useState({
      action: "",
      outcome: "",
      query: "",
      limit: 50,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const loadAudit = async (nextFilters = filters) => {
    setLoading(true);
    setError("");
    try {
      setData(await getAdminAuditLog(nextFilters));
    } catch (loadError) {
      setError(loadError.message || "Unable to load the audit log.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    loadAudit();
  }, []);
  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    if (key !== "query") loadAudit(next);
  };
  const entries = data?.entries || [],
    failures = entries.filter((entry) => entry.outcome === "FAILURE").length,
    logins = entries.filter(
      (entry) => entry.action === "LOGIN" && entry.outcome === "SUCCESS",
    ).length;
  return (
    <section className="audit-module">
      <section className="stats audit-stats">
        <article>
          <span>Visible events</span>
          <strong>{entries.length}</strong>
          <i className="green">
            <ClipboardList />
          </i>
        </article>
        <article>
          <span>Successful logins</span>
          <strong>{logins}</strong>
          <i className="blue">
            <ShieldCheck />
          </i>
        </article>
        <article>
          <span>Failed actions</span>
          <strong>{failures}</strong>
          <i className="gold">
            <X />
          </i>
        </article>
      </section>
      <section className="table-card">
        <div className="audit-toolbar">
          <div>
            <h2>Administrator audit trail</h2>
            <p>
              {entries.length}
              {data?.total > entries.length ? ` of ${data.total}` : ""} matching
              records · chain integrity{" "}
              <b
                className={
                  data?.integrity?.valid ? "integrity-good" : "integrity-bad"
                }
              >
                {data?.integrity?.valid ? "verified" : "warning"}
              </b>
            </p>
          </div>
          <div className="audit-filters">
            <select
              value={filters.action}
              onChange={(event) => updateFilter("action", event.target.value)}
              title="Filter by audited action"
            >
              <option value="">All actions</option>
              <option value="LOGIN">Login</option>
              <option value="LOGOUT">Logout</option>
              <option value="ACTIVITY_SAVE">Activity save</option>
              <option value="ACTIVITY_STATUS">Activity end / reopen</option>
              <option value="ACTIVITY_DELETE">Activity delete</option>
              <option value="CERTIFICATE_RETRY">Certificate retry</option>
              <option value="SIGNATURE_UPLOAD">Signature upload</option>
              <option value="USER_SAVE">User save</option>
              <option value="QUESTIONS_SAVE">Questions save</option>
            </select>
            <select
              value={filters.outcome}
              onChange={(event) => updateFilter("outcome", event.target.value)}
              title="Filter by outcome"
            >
              <option value="">All outcomes</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </select>
            <select
              className="audit-page-size"
              value={String(filters.limit)}
              onChange={(event) => updateFilter("limit", event.target.value)}
              title="How many entries to show"
              aria-label="Entries per page"
            >
              <option value="25">Show 25</option>
              <option value="50">Show 50</option>
              <option value="100">Show 100</option>
              <option value="all">Show all</option>
            </select>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                loadAudit();
              }}
              className="audit-search"
            >
              <input
                value={filters.query}
                onChange={(event) =>
                  setFilters({ ...filters, query: event.target.value })
                }
                placeholder="Actor, target, request ID…"
                aria-label="Search audit records"
              />
              <button className="mini-button" title="Apply audit search">
                Search
              </button>
            </form>
            <button
              className="mini-button"
              onClick={() => loadAudit()}
              disabled={loading}
              title="Refresh audit records"
            >
              {loading ? "Loading…" : (<><RefreshCw size={13} /> Refresh</>)}
            </button>
          </div>
        </div>
        {error && <div className="alert admin-alert">{error}</div>}
        {data?.integrity && !data.integrity.valid && (
          <div className="audit-integrity-warning">
            <ShieldCheck /> The audit hash chain does not match. A row may have
            been edited or deleted directly in Google Sheets.
          </div>
        )}
        <div className="table-scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Details</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && (
                <tr>
                  <td colSpan={7} className="skeleton-cell">
                    <SkeletonTable rows={6} columns={6} />
                  </td>
                </tr>
              )}
              {!loading && !entries.length && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    No audit entries match these filters.
                  </td>
                </tr>
              )}
              {entries.map((entry) => (
                <tr key={entry.audit_id}>
                  <td>{entry.timestamp}</td>
                  <td>
                    <strong>{entry.actor_email || "Unknown"}</strong>
                    <small>{entry.actor_role || "—"}</small>
                  </td>
                  <td>{entry.action}</td>
                  <td>
                    <strong>{entry.target_type}</strong>
                    <small>{entry.target_id || "—"}</small>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${entry.outcome === "SUCCESS" ? "enabled" : "disabled"}`}
                    >
                      {entry.outcome}
                    </span>
                  </td>
                  <td className="audit-details">
                    {entry.details?.operation ||
                      entry.details?.role ||
                      entry.details?.error ||
                      "—"}
                  </td>
                  <td className="audit-request">{entry.request_id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !entries.length && (
            <div className="empty-audit">
              No audit records match the current filters.
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function AnalyticsPanel({ data, activities, activityFilter, onFilter }) {
  // Placeholders shaped like the real tiles and bars, so the panel does not
  // reflow when the numbers land.
  if (!data)
    return (
      <section className="analytics-skeleton" role="status" aria-label="Loading analytics">
        <div className="stats">
          {[0, 1, 2].map((i) => (
            <article key={i}>
              <Skeleton width="46%" height={10} />
              <Skeleton width="34%" height={24} style={{ marginTop: 12 }} />
            </article>
          ))}
        </div>
        <div className="management-card">
          <Skeleton width={180} height={13} />
          <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "34px 1fr 44px", gap: 12, alignItems: "center" }}>
                <Skeleton width="100%" height={10} />
                <Skeleton width={`${88 - i * 6}%`} height={10} />
                <Skeleton width="100%" height={10} />
              </div>
            ))}
          </div>
        </div>
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
                {question.type === "text" ? (
                  // Long-text questions have no score; 0.00 would read as a
                  // terrible rating rather than "not applicable".
                  <>
                    <i />
                    <strong
                      className="muted-score"
                      title="Long text question — written answers are in the Responses sheet."
                    >
                      Text
                    </strong>
                  </>
                ) : question.type === "yesno" ? (
                  <>
                    <i>
                      <b style={{ width: `${question.yesRate || 0}%` }} />
                    </i>
                    <strong
                      title={`${question.responses || 0} yes/no answers`}
                    >
                      {Number(question.yesRate || 0).toFixed(0)}% yes
                    </strong>
                  </>
                ) : (
                  <>
                    <i>
                      <b style={{ width: `${(question.average / 5) * 100}%` }} />
                    </i>
                    <strong>{Number(question.average).toFixed(2)}</strong>
                  </>
                )}
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

// CHED regional offices. These strings are written to the Activity sheet's
// Region column and printed on certificates, so edit them with care: activities
// saved under an older label keep that label until they are edited.
const REGIONS = [
  "National Capital Region",
  "01 – Ilocos Region",
  "02 – Cagayan Valley",
  "03 – Central Luzon",
  "04 – CALABARZON",
  "05 – Bicol Region",
  "06 – Western Visayas",
  "07 – Central Visayas",
  "08 – Eastern Visayas",
  "09 – Zamboanga Peninsula",
  "10 – Northern Mindanao",
  "11 – Davao Region",
  "12 – Soccsksargen",
  "Caraga",
  "Cordillera Administrative Region",
  "Bangsamoro Autonomous Region in Muslim Mindanao",
  "MIMAROPA",
  "Negros Island Region",
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
    // The e-signature and template are not plain inputs, so the browser's own
    // `required` handling cannot catch them. Name what is missing instead of
    // letting the server return a generic "fill all required fields".
    const missing = [
      ["title", "Activity title"],
      ["region", "Region"],
      ["venue", "Venue"],
      ["fromDate", "Start date"],
      ["inCharge", "Signatory name"],
      ["signatoryDesignation", "Signatory designation"],
      ["signature", "E-signature image"],
      ["template", "Certificate template"],
    ]
      .filter(([key]) => !String(form[key] ?? "").trim())
      .map(([, label]) => label);
    if (missing.length) {
      setError(
        `Still needed: ${missing.join(", ")}.${
          missing.includes("E-signature image")
            ? " Upload a signature image, or pick a previous signatory to reuse one."
            : ""
        }`,
      );
      return;
    }
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
