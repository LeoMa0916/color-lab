const COOKIE_NAME = "color_lab_session";
// Cloudflare Workers currently reject PBKDF2 requests above 100,000 iterations.
const PASSWORD_ITERATIONS = 100000;
const REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TAB_SESSION_MS = 12 * 60 * 60 * 1000;
const LEGAL_VERSION = "2026-07-28";
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const MAX_STYLE_BYTES = 6 * 1024 * 1024;
const RAW_EXTENSIONS = new Set([
  "3fr", "ari", "arw", "bay", "cap", "cr2", "cr3", "crw", "dcr", "dcs",
  "dng", "drf", "eip", "erf", "fff", "gpr", "iiq", "k25", "kdc", "mdc",
  "mef", "mos", "mrw", "nef", "nrw", "obm", "orf", "pef", "ptx", "pxn",
  "r3d", "raf", "raw", "rw2", "rwl", "rwz", "sr2", "srf", "srw", "x3f",
]);

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function fail(status, message, code) {
  throw new ApiError(status, message, code);
}

function requireBindings(env, { photos = false } = {}) {
  if (!env.COLOR_LAB_DB) {
    fail(503, "云端账户数据库尚未完成绑定", "database-unavailable");
  }
  if (photos && !env.COLOR_LAB_PHOTOS) {
    fail(503, "云端照片存储尚未完成绑定", "storage-unavailable");
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function randomToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePasswordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey(
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
      salt: new TextEncoder().encode(salt),
      iterations,
    },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function normalizeUsername(username) {
  return String(username || "").trim().toLocaleLowerCase("zh-CN");
}

function validateUsername(username) {
  const value = String(username || "").trim();
  if (value.length < 3 || value.length > 24) {
    return "用户名需要 3–24 个字符";
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    return "用户名只能包含文字、数字、下划线或短横线";
  }
  return "";
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 8 || value.length > 128) return "密码需要 8–128 个字符";
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) {
    return "密码需要同时包含文字和数字";
  }
  return "";
}

function parseCookies(request) {
  const values = {};
  const cookie = request.headers.get("Cookie") || "";
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    values[item.slice(0, separator).trim()] = decodeURIComponent(
      item.slice(separator + 1).trim(),
    );
  }
  return values;
}

function sessionCookie(request, token, remember) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const sharedDomain = ["colorslab.top", "www.colorslab.top"].includes(url.hostname)
    ? "; Domain=colorslab.top"
    : "";
  const persistence = remember
    ? `; Max-Age=${Math.floor(REMEMBERED_SESSION_MS / 1000)}; Expires=${new Date(Date.now() + REMEMBERED_SESSION_MS).toUTCString()}`
    : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}${sharedDomain}${persistence}`;
}

function clearSessionCookie(request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const sharedDomain = ["colorslab.top", "www.colorslab.top"].includes(url.hostname)
    ? "; Domain=colorslab.top"
    : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}${sharedDomain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function requireLegalConsent(body) {
  if (body.acceptedTerms !== true) {
    fail(400, "请先阅读并同意用户协议与隐私政策", "legal-consent-required");
  }
}

function assertSameOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    fail(403, "请求来源校验失败", "invalid-origin");
  }
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_STYLE_BYTES) {
    fail(413, "请求内容过大", "request-too-large");
  }
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    fail(415, "需要 JSON 请求", "invalid-content-type");
  }
  return request.json().catch(() => fail(400, "请求内容无法解析", "invalid-json"));
}

async function getSession(context) {
  requireBindings(context.env);
  const token = parseCookies(context.request)[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const record = await context.env.COLOR_LAB_DB.prepare(`
    SELECT
      sessions.token_hash,
      sessions.remember,
      sessions.expires_at,
      users.id AS user_id,
      users.username
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(tokenHash, now).first();
  if (!record) return null;
  return {
    tokenHash,
    user: { id: record.user_id, username: record.username },
    remember: Boolean(record.remember),
    expiresAt: Number(record.expires_at),
  };
}

async function requireSession(context) {
  const session = await getSession(context);
  if (!session) fail(401, "登录状态已失效，请重新登录", "unauthorized");
  return session;
}

async function issueSession(context, user, remember) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + (remember ? REMEMBERED_SESSION_MS : TAB_SESSION_MS);
  await context.env.COLOR_LAB_DB.prepare(
    "DELETE FROM sessions WHERE expires_at <= ?",
  ).bind(now).run();
  await context.env.COLOR_LAB_DB.prepare(`
    INSERT INTO sessions (token_hash, user_id, remember, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenHash, user.id, remember ? 1 : 0, now, expiresAt).run();
  return {
    token,
    session: {
      username: user.username,
      remember: Boolean(remember),
      expiresAt,
      storageMode: "cloud",
    },
  };
}

async function rateLimitKey(context, scope, usernameKey = "") {
  const ip = context.request.headers.get("CF-Connecting-IP") || "local";
  return sha256(`${scope}:${ip}:${usernameKey}`);
}

async function recordAttempt(context, key) {
  const now = Date.now();
  const record = await context.env.COLOR_LAB_DB.prepare(
    "SELECT attempt_count, first_at, blocked_until FROM auth_attempts WHERE attempt_key = ?",
  ).bind(key).first();
  if (record?.blocked_until > now) {
    fail(429, "尝试次数过多，请稍后再试", "rate-limited");
  }
  const freshWindow = !record || now - Number(record.first_at) > AUTH_WINDOW_MS;
  const count = freshWindow ? 1 : Number(record.attempt_count) + 1;
  const firstAt = freshWindow ? now : Number(record.first_at);
  const blockedUntil = count >= AUTH_MAX_ATTEMPTS ? now + AUTH_WINDOW_MS : 0;
  await context.env.COLOR_LAB_DB.prepare(`
    INSERT INTO auth_attempts (attempt_key, attempt_count, first_at, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      attempt_count = excluded.attempt_count,
      first_at = excluded.first_at,
      blocked_until = excluded.blocked_until
  `).bind(key, count, firstAt, blockedUntil).run();
  if (blockedUntil) {
    fail(429, "尝试次数过多，请稍后再试", "rate-limited");
  }
}

async function clearAttempts(context, key) {
  await context.env.COLOR_LAB_DB.prepare(
    "DELETE FROM auth_attempts WHERE attempt_key = ?",
  ).bind(key).run();
}

async function register(context) {
  requireBindings(context.env);
  const body = await readJson(context.request);
  requireLegalConsent(body);
  const usernameError = validateUsername(body.username);
  if (usernameError) fail(400, usernameError, "invalid-username");
  const passwordError = validatePassword(body.password);
  if (passwordError) fail(400, passwordError, "invalid-password");
  const username = body.username.trim();
  const usernameKey = normalizeUsername(username);
  const limitKey = await rateLimitKey(context, "register");
  await recordAttempt(context, limitKey);
  const existing = await context.env.COLOR_LAB_DB.prepare(
    "SELECT id FROM users WHERE username_key = ?",
  ).bind(usernameKey).first();
  if (existing) fail(409, "这个用户名已经注册，请直接登录", "username-exists");
  const salt = randomToken(18);
  const passwordHash = await derivePasswordHash(body.password, salt);
  const user = { id: crypto.randomUUID(), username };
  await context.env.COLOR_LAB_DB.prepare(`
    INSERT INTO users (
      id, username, username_key, password_salt, password_hash,
      password_iterations, created_at, terms_version, privacy_version,
      terms_accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    user.username,
    usernameKey,
    salt,
    passwordHash,
    PASSWORD_ITERATIONS,
    Date.now(),
    LEGAL_VERSION,
    LEGAL_VERSION,
    Date.now(),
  ).run();
  await clearAttempts(context, limitKey);
  const issued = await issueSession(context, user, body.remember !== false);
  return json(
    { session: issued.session },
    201,
    { "Set-Cookie": sessionCookie(context.request, issued.token, issued.session.remember) },
  );
}

async function login(context) {
  requireBindings(context.env);
  const body = await readJson(context.request);
  requireLegalConsent(body);
  const usernameKey = normalizeUsername(body.username);
  const limitKey = await rateLimitKey(context, "login", usernameKey);
  await recordAttempt(context, limitKey);
  const record = await context.env.COLOR_LAB_DB.prepare(`
    SELECT id, username, password_salt, password_hash, password_iterations
    FROM users WHERE username_key = ?
  `).bind(usernameKey).first();
  const salt = record?.password_salt || "ColorLabConstantMissingAccountSalt";
  const iterations = Number(record?.password_iterations || PASSWORD_ITERATIONS);
  const candidate = await derivePasswordHash(body.password || "", salt, iterations);
  if (!record || !constantTimeTextEqual(candidate, record.password_hash)) {
    fail(401, "用户名或密码不正确", "invalid-credentials");
  }
  await context.env.COLOR_LAB_DB.prepare(`
    UPDATE users SET terms_version = ?, privacy_version = ?, terms_accepted_at = ?
    WHERE id = ?
  `).bind(LEGAL_VERSION, LEGAL_VERSION, Date.now(), record.id).run();
  await clearAttempts(context, limitKey);
  const issued = await issueSession(
    context,
    { id: record.id, username: record.username },
    body.remember !== false,
  );
  return json(
    { session: issued.session },
    200,
    { "Set-Cookie": sessionCookie(context.request, issued.token, issued.session.remember) },
  );
}

async function restoreSession(context) {
  const session = await getSession(context);
  if (!session) {
    return json(
      { session: null },
      200,
      { "Set-Cookie": clearSessionCookie(context.request) },
    );
  }
  return json({
    session: {
      username: session.user.username,
      remember: session.remember,
      expiresAt: session.expiresAt,
      storageMode: "cloud",
    },
  });
}

async function logout(context) {
  requireBindings(context.env);
  const token = parseCookies(context.request)[COOKIE_NAME];
  if (token) {
    const tokenHash = await sha256(token);
    await context.env.COLOR_LAB_DB.prepare(
      "DELETE FROM sessions WHERE token_hash = ?",
    ).bind(tokenHash).run();
  }
  return json(
    { ok: true },
    200,
    { "Set-Cookie": clearSessionCookie(context.request) },
  );
}

function extensionOf(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function validatePhoto(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    fail(400, "没有收到照片文件", "missing-file");
  }
  if (!file.size || file.size > MAX_UPLOAD_BYTES) {
    fail(413, "单张照片需要小于 95 MB", "file-too-large");
  }
  const extension = extensionOf(file.name);
  const isImage = String(file.type || "").startsWith("image/");
  if (!isImage && !RAW_EXTENSIONS.has(extension)) {
    fail(415, "不支持这个照片或 RAW 格式", "unsupported-file");
  }
}

function safeObjectName(name) {
  const extension = extensionOf(name);
  const base = String(name || "photo")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "photo";
  return extension ? `${base}.${extension}` : base;
}

function assetRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    contentType: record.content_type,
    size: Number(record.size),
    createdAt: Number(record.created_at),
  };
}

async function listAssets(context) {
  const session = await requireSession(context);
  const result = await context.env.COLOR_LAB_DB.prepare(`
    SELECT id, kind, name, content_type, size, created_at
    FROM assets
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).bind(session.user.id).all();
  return json({ assets: (result.results || []).map(assetRecord) });
}

async function uploadAsset(context) {
  requireBindings(context.env, { photos: true });
  const session = await requireSession(context);
  const contentLength = Number(context.request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    fail(413, "单张照片需要小于 95 MB", "file-too-large");
  }
  const form = await context.request.formData().catch(() =>
    fail(400, "上传内容无法解析", "invalid-upload"));
  const file = form.get("file");
  const kind = form.get("kind");
  if (!["reference", "target"].includes(kind)) {
    fail(400, "照片类型无效", "invalid-kind");
  }
  validatePhoto(file);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const objectKey = `${session.user.id}/${createdAt}-${id}-${safeObjectName(file.name)}`;
  await context.env.COLOR_LAB_PHOTOS.put(objectKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { kind, owner: session.user.id },
  });
  try {
    await context.env.COLOR_LAB_DB.prepare(`
      INSERT INTO assets (
        id, user_id, kind, name, content_type, size,
        object_key, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      session.user.id,
      kind,
      String(file.name).slice(0, 240),
      file.type || "application/octet-stream",
      file.size,
      objectKey,
      JSON.stringify({ raw: RAW_EXTENSIONS.has(extensionOf(file.name)) }),
      createdAt,
    ).run();
  } catch (error) {
    await context.env.COLOR_LAB_PHOTOS.delete(objectKey);
    throw error;
  }
  return json({
    asset: {
      id,
      kind,
      name: String(file.name).slice(0, 240),
      contentType: file.type || "application/octet-stream",
      size: file.size,
      createdAt,
    },
  }, 201);
}

async function ownedAsset(context, id) {
  const session = await requireSession(context);
  const record = await context.env.COLOR_LAB_DB.prepare(`
    SELECT id, kind, name, content_type, size, object_key, created_at
    FROM assets WHERE id = ? AND user_id = ?
  `).bind(id, session.user.id).first();
  if (!record) fail(404, "没有找到这张云端照片", "asset-not-found");
  return record;
}

async function downloadAsset(context, id) {
  requireBindings(context.env, { photos: true });
  const record = await ownedAsset(context, id);
  const object = await context.env.COLOR_LAB_PHOTOS.get(record.object_key);
  if (!object) fail(404, "云端照片文件已经不存在", "asset-file-missing");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(record.name)}`,
  );
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function deleteAsset(context, id) {
  requireBindings(context.env, { photos: true });
  const record = await ownedAsset(context, id);
  await context.env.COLOR_LAB_PHOTOS.delete(record.object_key);
  const session = await requireSession(context);
  await context.env.COLOR_LAB_DB.prepare(
    "DELETE FROM assets WHERE id = ? AND user_id = ?",
  ).bind(id, session.user.id).run();
  return json({ ok: true });
}

async function listStyles(context) {
  const session = await requireSession(context);
  const result = await context.env.COLOR_LAB_DB.prepare(`
    SELECT id, name, serialized, created_at, updated_at
    FROM styles
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 100
  `).bind(session.user.id).all();
  return json({
    styles: (result.results || []).map((record) => ({
      id: record.id,
      name: record.name,
      serialized: record.serialized,
      createdAt: Number(record.created_at),
      updatedAt: Number(record.updated_at),
    })),
  });
}

async function putStyle(context) {
  const session = await requireSession(context);
  const body = await readJson(context.request);
  const id = String(body.id || "");
  const name = String(body.name || "").trim();
  const serialized = String(body.serialized || "");
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    fail(400, "滤镜标识无效", "invalid-style-id");
  }
  if (!name || name.length > 80) {
    fail(400, "滤镜名称需要 1–80 个字符", "invalid-style-name");
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_STYLE_BYTES) {
    fail(413, "完整风格文件需要小于 6 MB", "style-too-large");
  }
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    fail(400, "完整风格文件无法解析", "invalid-style");
  }
  if (envelope?.format !== "com.colorlab.clstyle" || envelope?.schemaVersion !== 4) {
    fail(400, "只支持 Color Engine 4 完整风格", "invalid-style");
  }
  const now = Date.now();
  const createdAt = Number(body.createdAt) || now;
  await context.env.COLOR_LAB_DB.prepare(`
    INSERT INTO styles (id, user_id, name, serialized, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      serialized = excluded.serialized,
      updated_at = excluded.updated_at
    WHERE styles.user_id = excluded.user_id
  `).bind(id, session.user.id, name, serialized, createdAt, now).run();
  return json({ ok: true, updatedAt: now });
}

async function deleteStyle(context, id) {
  const session = await requireSession(context);
  await context.env.COLOR_LAB_DB.prepare(
    "DELETE FROM styles WHERE id = ? AND user_id = ?",
  ).bind(id, session.user.id).run();
  return json({ ok: true });
}

async function route(context) {
  assertSameOrigin(context.request);
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const parts = path ? path.split("/").map(decodeURIComponent) : [];
  const method = context.request.method;

  if (method === "GET" && parts[0] === "health") {
    return json({
      ok: Boolean(context.env.COLOR_LAB_DB),
      database: Boolean(context.env.COLOR_LAB_DB),
      photos: Boolean(context.env.COLOR_LAB_PHOTOS),
    });
  }
  if (method === "POST" && path === "auth/register") return register(context);
  if (method === "POST" && path === "auth/login") return login(context);
  if (method === "GET" && path === "auth/session") return restoreSession(context);
  if (method === "POST" && path === "auth/logout") return logout(context);
  if (method === "GET" && path === "library") return listAssets(context);
  if (method === "POST" && path === "library/upload") return uploadAsset(context);
  if (parts[0] === "library" && parts[1] && parts[2] === "file" && method === "GET") {
    return downloadAsset(context, parts[1]);
  }
  if (parts[0] === "library" && parts[1] && parts.length === 2 && method === "DELETE") {
    return deleteAsset(context, parts[1]);
  }
  if (method === "GET" && path === "styles") return listStyles(context);
  if (method === "PUT" && path === "styles") return putStyle(context);
  if (parts[0] === "styles" && parts[1] && parts.length === 2 && method === "DELETE") {
    return deleteStyle(context, parts[1]);
  }
  fail(404, "没有找到这个云端接口", "not-found");
}

export async function onRequest(context) {
  try {
    return await route(context);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ message: error.message, code: error.code }, error.status);
    }
    console.error("Color Lab cloud API error", error);
    return json(
      { message: "云端服务暂时不可用，请稍后重试", code: "internal-error" },
      500,
    );
  }
}
