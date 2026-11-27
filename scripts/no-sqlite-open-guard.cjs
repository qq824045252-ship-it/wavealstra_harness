// Preload for pure-DuckDB service gates. Report attempted opens even when callers catch their errors.
const Module = require("node:module");
const { appendFileSync } = require("node:fs");
const attempts = process.env.MYBUDDY_SQLITE_ATTEMPTS;
if (!attempts) throw new Error("Set MYBUDDY_SQLITE_ATTEMPTS to a temporary audit log");

function forbidOpen(driver) {
  return () => {
    const error = new Error("Unexpected SQLite open via " + driver);
    appendFileSync(attempts, error.stack + "\n");
    throw error;
  };
}
const sqlite = require("node:sqlite");
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, { construct: forbidOpen("node:sqlite") });
Module.syncBuiltinESMExports();
const sqliteURL = require("node:url").pathToFileURL(require.resolve("better-sqlite3")).href;
Module.registerHooks({
  load(url, context, nextLoad) {
    if (url !== sqliteURL) return nextLoad(url, context);
    return { format: "commonjs", shortCircuit: true, source:
      "module.exports = function Database() { const error = new Error('Unexpected SQLite open via better-sqlite3'); require('node:fs').appendFileSync(process.env.MYBUDDY_SQLITE_ATTEMPTS,error.stack+'\\n'); throw error; };" };
  },
});
