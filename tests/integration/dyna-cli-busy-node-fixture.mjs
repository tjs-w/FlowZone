import { DatabaseSync } from "node:sqlite";

const [databasePath] = globalThis.process.argv.slice(2);
if (!databasePath) throw new Error("Expected a database path.");

const database = new DatabaseSync(databasePath, { timeout: 0 });
database.exec("BEGIN IMMEDIATE");
globalThis.process.stdout.write("ready\n");
globalThis.process.stdin.resume();

function close() {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

globalThis.process.stdin.once("end", () => {
  close();
  globalThis.process.exit(0);
});
globalThis.process.once("SIGTERM", () => {
  close();
  globalThis.process.exit(0);
});
