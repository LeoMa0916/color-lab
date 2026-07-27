const ACCOUNT_STORAGE_KEY = "color-lab.accounts.v1";
const SESSION_STORAGE_KEY = "color-lab.session.v1";
const PASSWORD_ITERATIONS = 180000;
const REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TAB_SESSION_MS = 12 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

function getStorage(type) {
  try {
    return type === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
}

export async function derivePasswordHash(
  password,
  salt,
  iterations = PASSWORD_ITERATIONS,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function readAccounts() {
  const storage = getStorage("local");
  if (!storage) return [];
  try {
    const accounts = JSON.parse(storage.getItem(ACCOUNT_STORAGE_KEY) || "[]");
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts) {
  const storage = getStorage("local");
  if (!storage) throw new AuthError("当前浏览器不允许保存本机账户", "storage-unavailable");
  storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
}

function normalizedUsername(username) {
  return username.trim().toLocaleLowerCase("zh-CN");
}

export function validateUsername(username) {
  const value = username.trim();
  if (value.length < 3 || value.length > 24) {
    return "用户名需要 3–24 个字符";
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    return "用户名只能包含文字、数字、下划线或短横线";
  }
  return "";
}

export function validatePassword(password) {
  if (password.length < 8) return "密码至少需要 8 个字符";
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) {
    return "密码需要同时包含文字和数字";
  }
  return "";
}

async function issueSession(account, remember) {
  const token = bytesToBase64(randomBytes(32));
  const sessionHash = bytesToBase64(await sha256(token));
  const expiresAt = Date.now() + (remember ? REMEMBERED_SESSION_MS : TAB_SESSION_MS);
  const accounts = readAccounts().map((item) =>
    item.usernameKey === account.usernameKey
      ? { ...item, sessionHash, sessionExpiresAt: expiresAt }
      : item);
  writeAccounts(accounts);
  getStorage("local")?.removeItem(SESSION_STORAGE_KEY);
  getStorage("session")?.removeItem(SESSION_STORAGE_KEY);
  const session = JSON.stringify({
    usernameKey: account.usernameKey,
    token,
    expiresAt,
    remember,
  });
  getStorage(remember ? "local" : "session")?.setItem(SESSION_STORAGE_KEY, session);
  return { username: account.username, remember, expiresAt };
}

export async function registerLocalAccount({
  username,
  password,
  remember = true,
}) {
  const usernameError = validateUsername(username);
  if (usernameError) throw new AuthError(usernameError, "invalid-username");
  const passwordError = validatePassword(password);
  if (passwordError) throw new AuthError(passwordError, "invalid-password");
  const usernameKey = normalizedUsername(username);
  const accounts = readAccounts();
  if (accounts.some((account) => account.usernameKey === usernameKey)) {
    throw new AuthError("这个用户名已在本机注册，请直接登录", "username-exists");
  }
  const salt = randomBytes(16);
  const passwordHash = await derivePasswordHash(password, salt);
  const account = {
    username: username.trim(),
    usernameKey,
    salt: bytesToBase64(salt),
    passwordHash: bytesToBase64(passwordHash),
    iterations: PASSWORD_ITERATIONS,
    createdAt: Date.now(),
  };
  writeAccounts([...accounts, account]);
  return issueSession(account, remember);
}

export async function loginLocalAccount({
  username,
  password,
  remember = true,
}) {
  const usernameKey = normalizedUsername(username);
  const account = readAccounts().find((item) => item.usernameKey === usernameKey);
  if (!account) {
    throw new AuthError("没有找到这个本机账户，请先注册", "account-not-found");
  }
  const candidate = await derivePasswordHash(
    password,
    base64ToBytes(account.salt),
    account.iterations || PASSWORD_ITERATIONS,
  );
  if (!constantTimeEqual(candidate, base64ToBytes(account.passwordHash))) {
    throw new AuthError("密码不正确，请重新输入", "wrong-password");
  }
  return issueSession(account, remember);
}

function readSession(storage) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function restoreLocalSession() {
  const candidates = [
    [getStorage("local"), readSession(getStorage("local"))],
    [getStorage("session"), readSession(getStorage("session"))],
  ];
  for (const [storage, session] of candidates) {
    if (!session) continue;
    if (session.expiresAt <= Date.now()) {
      storage?.removeItem(SESSION_STORAGE_KEY);
      continue;
    }
    const account = readAccounts().find((item) => item.usernameKey === session.usernameKey);
    if (!account || account.sessionExpiresAt !== session.expiresAt) {
      storage?.removeItem(SESSION_STORAGE_KEY);
      continue;
    }
    const sessionHash = bytesToBase64(await sha256(session.token));
    if (sessionHash !== account.sessionHash) {
      storage?.removeItem(SESSION_STORAGE_KEY);
      continue;
    }
    return {
      username: account.username,
      remember: Boolean(session.remember),
      expiresAt: session.expiresAt,
    };
  }
  return null;
}

export function logoutLocalAccount() {
  getStorage("local")?.removeItem(SESSION_STORAGE_KEY);
  getStorage("session")?.removeItem(SESSION_STORAGE_KEY);
}
