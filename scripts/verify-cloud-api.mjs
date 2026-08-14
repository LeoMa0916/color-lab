import { readFile } from "node:fs/promises";
import { File } from "node:buffer";

const baseUrl = process.env.COLOR_LAB_API_URL || "http://127.0.0.1:4174";
const username = `cloud_qa_${Date.now()}`;
const password = "ColorLab2026";
let cookie = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Origin")) headers.set("Origin", baseUrl);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response;
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${body.message || ""}`);
  }
  return { response, body };
}

const health = await request("/api/health");
assert(health.ok, "Cloud API health endpoint is unavailable");
const healthBody = await health.json();
assert(healthBody.database && healthBody.photos, "D1 and R2 bindings are required");

const anonymousLibrary = await request("/api/library");
assert(anonymousLibrary.status === 401, "Anonymous users must not read the cloud library");

const missingConsent = await request("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password, remember: true }),
});
assert(missingConsent.status === 400, "Registration must require explicit legal consent");

const registration = await jsonRequest("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ username, password, remember: true, acceptedTerms: true }),
});
assert(registration.body.session.username === username, "Registration did not return the account");
assert(cookie.startsWith("color_lab_session="), "HttpOnly session cookie was not issued");

const restored = await jsonRequest("/api/auth/session");
assert(restored.body.session.username === username, "Session was not restored");

const styleId = `style_${crypto.randomUUID().replaceAll("-", "")}`;
const serialized = JSON.stringify({
  format: "com.colorlab.clstyle",
  schemaVersion: 5,
  engine: "Color Engine 5",
  style: {
    id: styleId,
    name: "Cloud QA",
    stats: { version: 4 },
    createdAt: Date.now(),
  },
});
await jsonRequest("/api/styles", {
  method: "PUT",
  body: JSON.stringify({
    id: styleId,
    name: "Cloud QA",
    serialized,
    createdAt: Date.now(),
  }),
});
const styles = await jsonRequest("/api/styles");
assert(styles.body.styles.some((item) => item.id === styleId), "Cloud style was not listed");

const photoBytes = await readFile(new URL("../public/demo/coast-target.png", import.meta.url));
const photo = new File([photoBytes], "cloud-qa.png", { type: "image/png" });
const uploadForm = new FormData();
uploadForm.append("kind", "target");
uploadForm.append("file", photo);
const uploadResponse = await request("/api/library/upload", {
  method: "POST",
  body: uploadForm,
});
const upload = await uploadResponse.json();
assert(uploadResponse.status === 201, `Photo upload failed: ${uploadResponse.status} ${upload.message || ""}`);
assert(upload.asset?.id, "Photo upload did not return an asset id");
const ownerCookie = cookie;

const library = await jsonRequest("/api/library");
assert(library.body.assets.some((item) => item.id === upload.asset.id), "Uploaded photo was not listed");

const download = await request(`/api/library/${upload.asset.id}/file`);
assert(download.ok, "Private photo could not be downloaded");
assert((await download.arrayBuffer()).byteLength === photoBytes.byteLength, "Downloaded photo size changed");

cookie = "";
const otherUsername = `cloud_qa2_${Date.now()}`;
await jsonRequest("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    username: otherUsername,
    password,
    remember: false,
    acceptedTerms: true,
  }),
});
const crossAccountDownload = await request(`/api/library/${upload.asset.id}/file`);
assert(crossAccountDownload.status === 404, "A different account could read a private photo");

cookie = ownerCookie;
const crossOriginMutation = await request("/api/auth/logout", {
  method: "POST",
  headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
  body: "{}",
});
assert(crossOriginMutation.status === 403, "Cross-origin mutations must be rejected");

await jsonRequest(`/api/library/${upload.asset.id}`, { method: "DELETE", body: "{}" });
await jsonRequest(`/api/styles/${styleId}`, { method: "DELETE", body: "{}" });
const cleared = await jsonRequest("/api/library");
assert(!cleared.body.assets.some((item) => item.id === upload.asset.id), "Deleted photo remains in the library");

await jsonRequest("/api/auth/logout", { method: "POST", body: "{}" });
const afterLogout = await jsonRequest("/api/auth/session");
assert(afterLogout.body.session === null, "Logged-out session should not be restored");

console.log("Cloud account verification passed", {
  sessionCookie: true,
  styleSync: true,
  privatePhotoRoundTrip: true,
  crossAccountIsolation: true,
  sameOriginMutations: true,
  deleteFlow: true,
  logout: true,
});
