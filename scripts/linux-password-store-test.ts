import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  describeLinuxSecretStore,
  installLinuxPasswordStore,
  installPlatformCredentialBackend,
  LINUX_PASSWORD_STORE_BACKEND,
  LINUX_PASSWORD_STORE_SWITCH,
} from "../src/main/platform/credentials";
import { switchValue } from "./linux-password-store-electron-stub";

const calls: Array<[string, string]> = [];
const record = {
  appendSwitch(key: string, value: string): void {
    calls.push([key, value]);
  },
};

assert.equal(installLinuxPasswordStore(record, "linux"), true);
assert.deepEqual(calls, [["password-store", LINUX_PASSWORD_STORE_SWITCH]]);

calls.length = 0;
assert.equal(installLinuxPasswordStore(record, "win32"), false);
assert.equal(installLinuxPasswordStore(record, "darwin"), false);
assert.deepEqual(calls, []);

// 平台装配入口：只有 Linux 注入开关，其它平台 no-op
calls.length = 0;
assert.equal(installPlatformCredentialBackend(record, "linux"), true);
assert.deepEqual(calls, [["password-store", LINUX_PASSWORD_STORE_SWITCH]]);
calls.length = 0;
assert.equal(installPlatformCredentialBackend(record, "windows"), false);
assert.equal(installPlatformCredentialBackend(record, "macos"), false);
assert.deepEqual(calls, []);

const unavailable = describeLinuxSecretStore({
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "basic_text",
}, "linux");
assert.equal(unavailable?.ready, false);
assert.equal(unavailable?.backend, "basic_text");

const ready = describeLinuxSecretStore({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => LINUX_PASSWORD_STORE_BACKEND,
}, "linux");
assert.equal(ready?.ready, true);

assert.equal(describeLinuxSecretStore({
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "basic_text",
}, "win32"), null);

if (process.platform === "linux") {
  assert.equal(switchValue("password-store"), LINUX_PASSWORD_STORE_SWITCH);
} else {
  assert.equal(switchValue("password-store"), undefined);
}

const firstImport = readFileSync("src/main/index.ts", "utf8")
  .split(/\r?\n/)
  .find((line) => line.startsWith("import "));
assert.equal(firstImport, 'import "./platform/credentials";');

console.log("linux-password-store: ok");
