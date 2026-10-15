import { test } from "node:test";
import assert from "node:assert/strict";
import { DATABASE_TIMEOUT, STALE_AFTER_MS, connectionKeeper } from "../../netlify/backend/db.mjs";

/**
 * The production connection, without a database: a fake client stands in for
 * postgres.js, and a fake clock for the time an instance spends frozen.
 */

function fakeClients() {
  const made = [];
  const connect = () => {
    const client = {
      ended: false,
      hang: false,
      unsafe(text) {
        if (client.hang) return new Promise(() => {}); // a dead connection: no answer, ever
        return Promise.resolve([{ text, client: made.indexOf(client) }]);
      },
      begin(fn) {
        return fn({ unsafe: (text) => client.unsafe(text) });
      },
      end() {
        client.ended = true;
        return Promise.resolve();
      },
    };
    made.push(client);
    return client;
  };
  return { made, connect };
}

test("a warm instance reuses its connection, but not after a quiet spell it may have slept through", async () => {
  const { made, connect } = fakeClients();
  let clock = 1_000_000;
  const database = connectionKeeper({ connect, now: () => clock });
  const first = database();
  assert.deepEqual(await first.query("select 1"), [{ text: "select 1", client: 0 }]);
  clock += STALE_AFTER_MS - 1; // the next request, inside the window
  assert.equal(database(), first);
  await first.query("select 2");
  clock += STALE_AFTER_MS + 1; // the instance slept longer than that
  const second = database();
  assert.notEqual(second, first);
  assert.deepEqual(await second.query("select 3"), [{ text: "select 3", client: 1 }]);
  assert.equal(made[0].ended, true, "the old connection is closed");
  assert.equal(made.length, 2);
});

test("a query that never answers ends in an error the browser retries, and the next request gets a fresh connection", async () => {
  const { made, connect } = fakeClients();
  const database = connectionKeeper({ connect, limitMs: 30 });
  const db = database();
  made[0].hang = true;
  await assert.rejects(db.query("select 1"), new Error(DATABASE_TIMEOUT));
  assert.match(DATABASE_TIMEOUT, /timeout/, "worded so src/lib/api.js retries it");
  assert.equal(made[0].ended, true);
  const fresh = database();
  assert.deepEqual(await fresh.query("select 2"), [{ text: "select 2", client: 1 }]);
});

test("a transaction that stops answering is abandoned the same way", async () => {
  const { made, connect } = fakeClients();
  const database = connectionKeeper({ connect, limitMs: 30 });
  const db = database();
  made[0].hang = true;
  await assert.rejects(db.transaction((tx) => tx.query("insert …")), new Error(DATABASE_TIMEOUT));
  assert.equal(made[0].ended, true);
  assert.equal(database().transaction((tx) => tx.query("select 1")) instanceof Promise, true);
});
