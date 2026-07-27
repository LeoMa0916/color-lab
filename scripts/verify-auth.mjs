import { webcrypto } from "node:crypto";
import {
  AuthError,
  derivePasswordHash,
  loginLocalAccount,
  logoutLocalAccount,
  registerLocalAccount,
  restoreLocalSession,
  validatePassword,
  validateUsername,
} from "../src/authStore.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  clear() {
    this.#values.clear();
  }
}

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) {
  globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
}
if (!globalThis.atob) {
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.window = { localStorage, sessionStorage };

assert(validateUsername("影像创作者_01") === "", "Unicode username should be accepted");
assert(validateUsername("ab"), "Short username should be rejected");
assert(validatePassword("ColorLab2026") === "", "Strong password should be accepted");
assert(validatePassword("password"), "Password without a number should be rejected");

const salt = new Uint8Array(16).fill(17);
const [firstHash, matchingHash, changedHash] = await Promise.all([
  derivePasswordHash("ColorLab2026", salt, 1000),
  derivePasswordHash("ColorLab2026", salt, 1000),
  derivePasswordHash("ColorLab2027", salt, 1000),
]);
assert(
  Buffer.from(firstHash).equals(Buffer.from(matchingHash)),
  "Password derivation should be deterministic for the same salt",
);
assert(
  !Buffer.from(firstHash).equals(Buffer.from(changedHash)),
  "Different passwords must not produce the same derived hash",
);

const registered = await registerLocalAccount({
  username: "engine_qa",
  password: "ColorLab2026",
  remember: true,
});
assert(registered.username === "engine_qa", "Registration should return the account");
assert(localStorage.getItem("color-lab.accounts.v1"), "Account record was not stored");
assert(
  !localStorage.getItem("color-lab.accounts.v1").includes("ColorLab2026"),
  "Plaintext password must never be stored",
);
assert(await restoreLocalSession(), "Remembered session should be restored");

logoutLocalAccount();
assert(!(await restoreLocalSession()), "Logged-out session should not be restored");

let wrongPasswordRejected = false;
try {
  await loginLocalAccount({
    username: "engine_qa",
    password: "Incorrect2026",
    remember: false,
  });
} catch (error) {
  wrongPasswordRejected = error instanceof AuthError && error.code === "wrong-password";
}
assert(wrongPasswordRejected, "Wrong password should be rejected");

const session = await loginLocalAccount({
  username: "ENGINE_QA",
  password: "ColorLab2026",
  remember: false,
});
assert(session.username === "engine_qa", "Login should be case-insensitive");
assert(
  sessionStorage.getItem("color-lab.session.v1"),
  "Non-remembered login should use tab session storage",
);

console.log("Local account verification passed", {
  passwordStoredInPlaintext: false,
  rememberedSession: true,
  tabSession: true,
  wrongPasswordRejected,
});
