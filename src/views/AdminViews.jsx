import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ClipboardList,
  Download,
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
  getAdminActivities,
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
import { Brand, TurnstileWidget } from "./shared";

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
    users: ["Users", "Create and maintain administrator access."],
    questions: [
      "Survey questions",
      "Edit the 15 participant rating questions.",
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

function AuditPanel() {
  const [data, setData] = useState(null),
    [filters, setFilters] = useState({
      action: "",
      outcome: "",
      query: "",
      limit: 200,
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
              {data?.total || 0} matching records · chain integrity{" "}
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
              <option value="ACTIVITY_DELETE">Activity delete</option>
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
              {loading ? "Loading…" : "Refresh"}
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
