const GAS_URL = import.meta.env.VITE_GAS_WEB_APP_URL || "";
const USE_NETLIFY_PROXY =
  import.meta.env.PROD || import.meta.env.VITE_USE_NETLIFY_PROXY === "true";
const REMOTE_URL = USE_NETLIFY_PROXY
  ? "/.netlify/functions/gas-proxy"
  : GAS_URL;
const HAS_REMOTE = Boolean(REMOTE_URL);
const DEMO_MODE =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO_MODE === "true";
const SESSION_KEY = "participant_feedback_admin_session";
const adminToken = () => {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}").token || "";
  } catch {
    return "";
  }
};
export const readAdminSession = () => {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (session?.expiresAt && session.expiresAt > Date.now()) return session;
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  } catch {
    return null;
  }
};
export const storeAdminSession = (session) =>
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
export const clearAdminSession = () => sessionStorage.removeItem(SESSION_KEY);

const demoActivities = [
  {
    id: "A-2026C1",
    title: "Regional Quality Assurance Conference 2026",
    venue: "PICC, Pasay City",
    date: "August 12–13, 2026",
  },
  {
    id: "A-2026W2",
    title: "Higher Education Leadership Workshop",
    venue: "CHED Central Office",
    date: "September 4, 2026",
  },
];

const demoAnalytics = {
  totalResponses: 128,
  averageScore: 4.42,
  completionRate: 96.8,
  certificates: { queued: 6, processing: 1, issued: 118, failed: 3 },
  distribution: [2, 5, 14, 39, 68],
  questions: [
    4.7, 4.6, 4.5, 4.4, 4.3, 4.5, 4.1, 4.2, 4.6, 4.4, 4.5, 4.6, 4.7, 4.4, 4.2,
  ].map((average, index) => ({ label: `Question ${index + 1}`, average })),
};

export const demoQuestions = [
  "The activity objectives were clearly communicated.",
  "The topics were relevant to my work.",
  "The speakers demonstrated strong subject knowledge.",
  "The presentations were clear and well organized.",
  "The learning materials supported the sessions.",
  "The activities encouraged meaningful participation.",
  "The time allotted for each session was appropriate.",
  "The venue and facilities supported learning.",
  "The event staff were helpful and professional.",
  "The registration process was smooth.",
  "The activity met my expectations.",
  "I gained knowledge I can apply in my role.",
  "I would recommend this activity to colleagues.",
  "Overall, how satisfied are you with the activity?",
  "How likely are you to attend a similar activity?",
];

function gasRun(method, ...args) {
  return new Promise((resolve, reject) => {
    const runner = window.google?.script?.run;
    if (!runner) return reject(new Error("GAS bridge unavailable"));
    runner
      .withSuccessHandler(resolve)
      .withFailureHandler((e) => reject(new Error(e?.message || String(e))))
      [method](...args);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requireBackend = () => {
  if (!HAS_REMOTE && !window.google?.script)
    throw new Error("The production backend is not configured.");
};

async function remote(action, payload = {}, attempt = 0) {
  try {
    const response = await fetch(REMOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false)
      throw new Error(data.error || "Request failed");
    return data.data ?? data;
  } catch (error) {
    const retryable =
      /lock|busy|simultaneous|too many|network|fetch|temporar|timeout/i.test(
        String(error?.message || error),
      );
    if (action === "submitFeedback" && retryable && attempt < 5) {
      const delay =
        Math.min(12000, 750 * 2 ** attempt) + Math.floor(Math.random() * 700);
      await sleep(delay);
      return remote(action, payload, attempt + 1);
    }
    throw error;
  }
}

export async function getActivities() {
  if (DEMO_MODE && !HAS_REMOTE) return demoActivities;
  requireBackend();
  return window.google?.script
    ? gasRun("getActivityData")
    : remote("getActivityData");
}
export async function getQuestions() {
  if (DEMO_MODE && !HAS_REMOTE) return demoQuestions;
  requireBackend();
  const q = window.google?.script
    ? await gasRun("getQuestions")
    : await remote("getQuestions");
  const questions = Array.from({ length: 15 }, (_, i) =>
    String(q[`question${i + 1}`] || "").trim(),
  );
  if (questions.some((question) => !question))
    throw new Error(
      "The survey questions are not configured. Ask a superadmin to complete the Questions module.",
    );
  return questions;
}
export async function submitFeedback(payload, turnstileToken = "") {
  if (window.google?.script) return gasRun("submitFeedback", payload);
  if (HAS_REMOTE) return remote("submitFeedback", { payload, turnstileToken });
  if (DEMO_MODE) {
    await sleep(500);
    return { status: "QUEUED", message: "Demo feedback queued." };
  }
  requireBackend();
}
export async function getAdminActivities() {
  if (window.google?.script) return gasRun("adminGetActivities", adminToken());
  if (HAS_REMOTE)
    return remote("adminGetActivities", { adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return demoActivities.map((a, i) => ({
    ...a,
    fromDate: "2026-08-12",
    toDate: "2026-08-13",
    givenDate: "2026-08-14",
    region: i ? "Region 4A" : "NCR",
    inCharge: i ? "Maria Santos" : "Alex Reyes",
    signatoryDesignation: i ? "Regional Director" : "Executive Director",
    signature: "Sample e-signature.png",
    template: "Certificate Template.pptx",
  }));
}
export async function saveActivity(payload) {
  if (window.google?.script)
    return gasRun("adminSaveActivity", payload, adminToken());
  if (HAS_REMOTE)
    return remote("adminSaveActivity", { payload, adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return payload;
}
export async function deleteActivity(id) {
  if (window.google?.script)
    return gasRun("adminDeleteActivity", id, adminToken());
  if (HAS_REMOTE)
    return remote("adminDeleteActivity", { id, adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return true;
}
export async function uploadSignature(file) {
  if (!file || file.size > 2 * 1024 * 1024)
    throw new Error("E-signature images must be 2 MB or smaller.");
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const payload = { filename: file.name, mimeType: file.type, base64 };
  if (window.google?.script)
    return gasRun("adminUploadSignature", payload, adminToken());
  if (HAS_REMOTE)
    return remote("adminUploadSignature", {
      payload,
      adminToken: adminToken(),
    });
  if (!DEMO_MODE) requireBackend();
  return { name: file.name, url: `local://${file.name}` };
}
export async function getFeedbackAnalytics(activityId = "") {
  if (window.google?.script)
    return gasRun("adminGetFeedbackAnalytics", activityId, adminToken());
  if (HAS_REMOTE)
    return remote("adminGetFeedbackAnalytics", {
      adminToken: adminToken(),
      activityId,
    });
  if (!DEMO_MODE) requireBackend();
  const selected = activityId
    ? {
        ...demoAnalytics,
        totalResponses: 54,
        averageScore: 4.56,
        completionRate: 98.1,
        distribution: [0, 1, 5, 17, 31],
      }
    : demoAnalytics;
  return {
    ...selected,
    scope: activityId || "all",
    overallAverage: 4.42,
    overallResponses: 128,
    scoreDelta: activityId ? 0.14 : 0,
    positiveRate: 83.6,
    certificateIssueRate: 92.2,
  };
}
export async function getAdminUsers() {
  if (window.google?.script) return gasRun("adminGetUsers", adminToken());
  if (HAS_REMOTE) return remote("adminGetUsers", { adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return [
    {
      user_id: "U-DEMO001",
      name: "Portal Host",
      role: "superadmin",
      email: "host@example.com",
      active: true,
      created_at: "2026-07-29",
      updated_at: "2026-07-29",
    },
  ];
}
export async function saveAdminUser(payload) {
  if (window.google?.script)
    return gasRun("adminSaveUser", payload, adminToken());
  if (HAS_REMOTE)
    return remote("adminSaveUser", { payload, adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return { ...payload, user_id: payload.user_id || `U-${Date.now()}` };
}
export async function getAdminQuestions() {
  if (window.google?.script) return gasRun("adminGetQuestions", adminToken());
  if (HAS_REMOTE)
    return remote("adminGetQuestions", { adminToken: adminToken() });
  if (!DEMO_MODE) requireBackend();
  return demoQuestions;
}
export async function saveAdminQuestions(questions) {
  if (window.google?.script)
    return gasRun("adminSaveQuestions", questions, adminToken());
  if (HAS_REMOTE)
    return remote("adminSaveQuestions", {
      questions,
      adminToken: adminToken(),
    });
  if (!DEMO_MODE) requireBackend();
  return questions;
}
export async function verifyCertificate(code) {
  if (window.google?.script) return gasRun("verifyCertificate", code);
  if (HAS_REMOTE) return remote("verifyCertificate", { code });
  if (!DEMO_MODE) requireBackend();
  return { valid: false };
}
export async function adminLogin(email, password, turnstileToken = "") {
  if (!HAS_REMOTE && !DEMO_MODE) requireBackend();
  const session = HAS_REMOTE
    ? await remote("adminLogin", { email, password, turnstileToken })
    : {
        token: "demo-session",
        user: { email, name: "Portal Host", role: "superadmin" },
        expiresAt: Date.now() + 21600000,
      };
  storeAdminSession(session);
  return session;
}
export async function adminLogout() {
  try {
    if (HAS_REMOTE && adminToken())
      await remote("adminLogout", { adminToken: adminToken() });
  } finally {
    clearAdminSession();
  }
}
