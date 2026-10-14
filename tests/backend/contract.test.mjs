import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESPONSES, appsScript, comparableAnalytics, comparableQueue, comparableResponses, flatQuestions, json, newBackend, withoutKeys,
} from "./contract-harness.mjs";

/**
 * Contract tests for the read actions: one shared fixture, the same request
 * to the real Code.gs and to the new backend, identical answers required.
 * Set aside only what is meant to differ: IDs (sheet row numbers become
 * permanent IDs) and edit timestamps.
 */

const both = Promise.all([appsScript(), newBackend()]);

test("contract: the survey's activity list", async () => {
  const [{ gas }, next] = await both;
  assert.deepEqual(await next.call("getActivityData"), json(gas.getActivityData()));
});

test("contract: the survey's questions", async () => {
  const [{ gas }, next] = await both;
  const sections = await next.call("getQuestions");
  assert.deepEqual(flatQuestions(sections), flatQuestions(json(gas.getQuestions())));
  // Code.gs pages 15 questions five at a time; the fixture has one section, so one page.
  assert.deepEqual(sections.sections.map((s) => [s.name, s.questions.length]), [["All", 15]]);
});

for (const [label, code] of [["issued", RESPONSES[0].code], ["issued, typed in lower case", RESPONSES[0].code.toLowerCase()],
  ["failed", RESPONSES[1].code], ["waiting", RESPONSES[2].code], ["unknown", "CHED-FFFFFFFFFFFFFFFFFFFF"], ["malformed", "not-a-code"]])
  test(`contract: verifying a certificate (${label})`, async () => {
    const [{ gas }, next] = await both;
    assert.deepEqual(await next.call("verifyCertificate", { code }), json(gas.verifyCertificate(code)));
  });

test("contract: Activities", async () => {
  const [{ gas }, next] = await both;
  assert.deepEqual(withoutKeys(await next.call("adminGetActivities"), "id", "Timestamp"),
    withoutKeys(json(gas.adminGetActivities("tok")), "id", "Timestamp"));
});

for (const filters of [{}, { activityId: "a-forum" }, { state: "FAILED" }, { state: "PROCESSING" }, { query: "bo@ex" }, { query: "workshop" }])
  test(`contract: Responses ${JSON.stringify(filters)}`, async () => {
    const [{ gas }, next] = await both;
    const expected = json(gas.adminGetResponses(filters, "tok"));
    const actual = await next.call("adminGetResponses", { filters });
    assert.equal(actual.total, expected.total);
    assert.deepEqual(comparableResponses(actual.entries), comparableResponses(expected.entries));
  });

for (const filters of [{}, { state: "QUEUED" }, { state: "ISSUED" }, { state: "PROCESSING", activityId: "A-WORK" }])
  test(`contract: Certificates ${JSON.stringify(filters)}`, async () => {
    const [{ gas }, next] = await both;
    const expected = json(gas.adminGetCertificateQueue(filters, "tok"));
    const actual = await next.call("adminGetCertificateQueue", { filters });
    assert.deepEqual(comparableQueue(actual), comparableQueue(expected));
  });

for (const activityId of ["", "A-FORUM", "A-WORK", "A-NEXT", "a-forum"])
  test(`contract: Analytics "${activityId}"`, async () => {
    const [{ gas }, next] = await both;
    assert.deepEqual(comparableAnalytics(await next.call("adminGetFeedbackAnalytics", { activityId })),
      json(gas.adminGetFeedbackAnalytics(activityId, "tok")));
  });

test("contract: Dashboard", async () => {
  const [{ gas }, next] = await both;
  const expected = json(gas.adminGetDashboard({ activityId: "A-FORUM" }, "tok"));
  const actual = await next.call("adminGetDashboard", { filters: { activityId: "A-FORUM" } });
  assert.deepEqual(comparableAnalytics(actual.analytics), expected.analytics);
  assert.deepEqual(withoutKeys(actual.activities, "id", "Timestamp"), withoutKeys(expected.activities, "id", "Timestamp"));
});
