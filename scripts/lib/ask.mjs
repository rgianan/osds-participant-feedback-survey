import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/**
 * One line from the terminal. With `hidden`, what is typed or pasted is not
 * shown and never reaches shell history, which is how the scripts take
 * connection strings and secrets: never on the command line.
 */
export function ask(question, hidden) {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      // Nothing was shown, so say what arrived: a doubled paste shows as twice the length.
      if (hidden) process.stdout.write(answer.trim() ? `  (received ${answer.trim().length} characters)\n` : "  (skipped)\n");
      resolve(answer.trim());
    });
    muted = hidden;
  });
}
