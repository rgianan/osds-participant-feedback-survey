import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

/**
 * The new backend in its own thread (worker-thread.mjs), called
 * synchronously: Code.gs's UrlFetchApp.fetch must return its answer, not a
 * promise, so the stand-in for it waits on the thread.
 */
export function backendThread({ portalBaseUrl = "https://portal.test" } = {}) {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const thread = new Worker(new URL("./worker-thread.mjs", import.meta.url), {
    workerData: { port: port2, signal, portalBaseUrl },
    transferList: [port2],
  });
  const wait = () => {
    Atomics.wait(signal, 0, 0, 60_000);
    Atomics.store(signal, 0, 0);
    return receiveMessageOnPort(port1).message;
  };
  wait(); // ready: migrations applied
  const send = (message) => {
    port1.postMessage(message);
    const reply = wait();
    if (reply?.thrown) throw new Error(reply.error);
    return reply;
  };
  return {
    sql: (text, params = []) => {
      const reply = send({ type: "sql", text, params });
      if (!reply.ok) throw new Error(reply.error);
      return reply.rows;
    },
    worker: (body) => send({ type: "worker", body }),
    action: (body, now, secrets = {}) => send({ type: "action", body, now: now.toISOString(), secrets }),
    importSheets: (exported, options = {}) => send({ type: "import", exported, options: { ...options, now: options.now?.toISOString() } }),
    compare: (exported, options = {}) => send({ type: "compare", exported, options: { ...options, now: options.now?.toISOString() } }),
    stop: () => thread.terminate(),
  };
}
