import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITIES, appsScript, comparableQueue, comparableResponses, json, newBackend, withoutKeys } from "./contract-harness.mjs";

/**
 * Contract tests for the actions that change data. Each test runs the same
 * sequence of requests against the real Code.gs and the new backend, from the
 * same starting data, and after every step requires the same reply AND the
 * same data afterwards. IDs differ by design (sheet rows vs permanent IDs), so
 * each side is addressed with its own ID for the same activity or response.
 */

const listOf = async (apps, next) => [
  withoutKeys(json(apps.gas.adminGetActivities("tok")), "id", "Timestamp"),
  withoutKeys(await next.call("adminGetActivities"), "id", "Timestamp"),
];

test("contract: saving, ending, reopening and deleting activities", async () => {
  const apps = appsScript();
  const next = await newBackend();
  const gasId = (code) => json(apps.gas.adminGetActivities("tok")).find((a) => a.activityId === code)?.id;
  const nextId = async (code) => (await next.call("adminGetActivities")).find((a) => a.activityId === code)?.id;
  const fields = {
    title: "Regional Forum", venue: "Hall C", fromDate: "2026-08-24", toDate: "2026-08-25", givenDate: "2026-08-26",
    template: "https://drive/template", inCharge: "Maria Santos", region: "NCR", signatoryDesignation: "Director",
    signature: "https://drive/signature",
  };

  // [what, who, Code.gs call, new-backend request] — each request built from
  // that side's own IDs at the moment it runs.
  const steps = [
    ["create", "helper", () => apps.run("adminSaveActivity", { ...fields, activityId: "A-NEW" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, activityId: "A-NEW" } })],
    ["create without a venue", "helper", () => apps.run("adminSaveActivity", { ...fields, venue: "" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, venue: "" } })],
    ["create ending before it starts", "helper", () => apps.run("adminSaveActivity", { ...fields, toDate: "2026-08-01" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, toDate: "2026-08-01" } })],
    ["edit own activity", "helper",
      () => apps.run("adminSaveActivity", { ...fields, title: "Leadership Forum 2026", id: gasId("A-FORUM"), activityId: "A-FORUM" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, title: "Leadership Forum 2026", id: await nextId("A-FORUM"), activityId: "A-FORUM" } })],
    ["edit someone else's activity", "helper",
      () => apps.run("adminSaveActivity", { ...fields, id: gasId("A-WORK"), activityId: "A-WORK" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, id: await nextId("A-WORK"), activityId: "A-WORK" } })],
    ["edit with a code that does not match", "helper",
      () => apps.run("adminSaveActivity", { ...fields, id: gasId("A-FORUM"), activityId: "A-WORK" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, id: await nextId("A-FORUM"), activityId: "A-WORK" } })],
    ["end own activity", "helper",
      () => apps.run("adminSetActivityStatus", { id: gasId("A-FORUM"), active: false, activityId: "A-FORUM" }, "tok"),
      async () => next.reply("adminSetActivityStatus", { payload: { id: await nextId("A-FORUM"), active: false, activityId: "A-FORUM" } })],
    ["reopen someone else's activity", "helper",
      () => apps.run("adminSetActivityStatus", { id: gasId("A-WORK"), active: true }, "tok"),
      async () => next.reply("adminSetActivityStatus", { payload: { id: await nextId("A-WORK"), active: true } })],
    ["a superadmin reopens it", "boss",
      () => apps.run("adminSetActivityStatus", { id: gasId("A-WORK"), active: "true" }, "tok"),
      async () => next.reply("adminSetActivityStatus", { payload: { id: await nextId("A-WORK"), active: "true" } })],
    ["edit an activity nobody owns", "helper",
      () => apps.run("adminSaveActivity", { ...fields, id: gasId("A-NEXT"), activityId: "A-NEXT" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, id: await nextId("A-NEXT"), activityId: "A-NEXT" } })],
    ["a superadmin edits it and becomes its owner", "boss",
      () => apps.run("adminSaveActivity", { ...fields, title: "Planning Summit", id: gasId("A-NEXT"), activityId: "A-NEXT" }, "tok"),
      async () => next.reply("adminSaveActivity", { payload: { ...fields, title: "Planning Summit", id: await nextId("A-NEXT"), activityId: "A-NEXT" } })],
    ["delete someone else's activity", "helper",
      () => apps.run("adminDeleteActivity", gasId("A-WORK"), "tok", "A-WORK"),
      async () => next.reply("adminDeleteActivity", { id: await nextId("A-WORK"), activityId: "A-WORK" })],
    ["delete own activity", "helper",
      () => apps.run("adminDeleteActivity", gasId("A-NEW"), "tok", "A-NEW"),
      async () => next.reply("adminDeleteActivity", { id: await nextId("A-NEW"), activityId: "A-NEW" })],
  ];

  for (const [what, who, viaGas, viaNext] of steps) {
    apps.as(who);
    next.as(who);
    const expected = viaGas();
    const actual = await viaNext();
    // A status change answers with the activity's ID, which differs by design.
    if (expected.data?.id !== undefined) delete expected.data.id;
    if (actual.data?.id !== undefined) delete actual.data.id;
    assert.deepEqual(actual, expected, `reply: ${what}`);
    apps.as("helper");
    next.as("helper");
    const [gasList, nextList] = await listOf(apps, next);
    assert.deepEqual(nextList, gasList, `activities after: ${what}`);
  }
});

test("contract: retrying certificates", async () => {
  const apps = appsScript();
  const next = await newBackend();
  // Response i is sheet row i + 2 in Code.gs and responseIds[i] in Postgres.
  // Fixture: 0 issued, 1 failed, 2 waiting, 3 stuck (processing, no live claim).
  const gasRows = (indexes) => indexes.map((i) => (typeof i === "number" ? i + 2 : i));
  const nextRows = (indexes) => indexes.map((i) => (typeof i === "number" ? next.responseIds[i] : i));
  const backToIndex = {
    gas: (value) => (typeof value === "number" ? value - 2 : value),
    next: (value) => (typeof value === "number" ? next.responseIds.indexOf(value) : value),
  };
  const retry = async (indexes) => {
    const expected = apps.run("adminRetryCertificates", { rows: gasRows(indexes) }, "tok");
    const actual = await next.reply("adminRetryCertificates", { payload: { rows: nextRows(indexes) } });
    if (expected.ok) expected.data.skipped = expected.data.skipped.map(backToIndex.gas);
    if (actual.ok) actual.data.skipped = actual.data.skipped.map(backToIndex.next);
    return [actual, expected];
  };

  const [actual, expected] = await retry([1, 0, 3, 2, "abc"]);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.data, { requeued: 2, skipped: [0, 2, "abc"] }, "failed and stuck are re-queued; issued, waiting and junk are not");

  for (const filters of [{ state: "QUEUED" }, { state: "FAILED" }, { state: "PROCESSING" }]) {
    const gasQueue = json(apps.gas.adminGetCertificateQueue(filters, "tok"));
    const nextQueue = await next.call("adminGetCertificateQueue", { filters });
    assert.deepEqual(comparableQueue(nextQueue), comparableQueue(gasQueue), `queue after retry: ${filters.state}`);
  }

  assert.deepEqual(...(await retry([])), "nothing selected");
  assert.deepEqual(...(await retry(Array.from({ length: 101 }, () => 1))), "more than 100");
});

test("contract: participant submissions", async () => {
  const apps = appsScript();
  const next = await newBackend();
  // What the survey page sends: the chosen activity's own title, venue and
  // date, as listed. (Code.gs takes the first sheet row matching the code OR
  // the title, so a request mixing one activity's code with another's title
  // can land on the wrong activity; the new backend matches the code first.)
  const form = (overrides = {}) => {
    const activity = ACTIVITIES.find((a) => a.code === (overrides.activityId ?? "A-FORUM")) ?? {};
    return {
      name: " Eve Cruz ", email: "eve@example.com", sex: "Female", age: "41", activityId: "A-FORUM",
      title: activity.title ?? "", venue: activity.venue ?? "", activity_date: activity.from ?? "",
      ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`answer${i + 1}`, (i % 5) + 1])),
      answer14: "Yes", answer15: "More case studies", takeaways: "Planning", suggestions: "",
      ...overrides,
    };
  };
  const submissions = [
    ["a new participant", form()],
    ["the same email again, different case", form({ email: "EVE@example.com", name: "Eve C." })],
    ["a participant whose first certificate failed", form({ email: "bo@example.com", name: "Bo" })],
    ["an ended activity", form({ email: "fay@example.com", activityId: "A-WORK" })],
    ["an activity not open yet", form({ email: "gus@example.com", activityId: "A-NEXT" })],
    ["an unknown activity", form({ email: "hal@example.com", activityId: "A-NOPE", title: "No Such Activity" })],
    ["no name", form({ email: "ivy@example.com", name: "" })],
    ["a bad email", form({ email: "jo@example" })],
    ["no sex", form({ email: "kim@example.com", sex: "" })],
    ["age 0", form({ email: "lu@example.com", age: "0" })],
    ["the honeypot", form({ email: "bot@example.com", website: "http://spam" })],
  ];
  for (const [what, payload] of submissions) {
    const expected = apps.run("submitFeedback", structuredClone(payload));
    const actual = await next.reply("submitFeedback", { payload: structuredClone(payload) });
    // queueRow is the new response's sheet row or ID: different by design.
    if (expected.data) delete expected.data.queueRow;
    if (actual.data) delete actual.data.queueRow;
    assert.deepEqual(actual, expected, `reply: ${what}`);
  }
  // And the stored responses read back the same. Submission time and the
  // verification code are generated at the moment, so they are set aside.
  const gasResponses = json(apps.gas.adminGetResponses({}, "tok"));
  const nextResponses = await next.call("adminGetResponses", { filters: {} });
  assert.equal(nextResponses.total, gasResponses.total);
  assert.deepEqual(withoutKeys(comparableResponses(nextResponses.entries), "submittedAt", "verificationCode"),
    withoutKeys(comparableResponses(gasResponses.entries), "submittedAt", "verificationCode"));
});
