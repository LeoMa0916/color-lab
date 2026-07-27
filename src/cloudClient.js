import {
  loginLocalAccount,
  logoutLocalAccount,
  registerLocalAccount,
  restoreLocalSession,
  validatePassword,
  validateUsername,
} from "./authStore";
import { deserializeClstyle, serializeClstyle } from "./styleStore";

const API_ROOT = "/api";

export { validatePassword, validateUsername };

export class CloudApiError extends Error {
  constructor(message, code = "request-failed", status = 0) {
    super(message);
    this.name = "CloudApiError";
    this.code = code;
    this.status = status;
  }
}

function isLocalPreview() {
  if (typeof window === "undefined") return false;
  return ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
}

async function parseResponse(response) {
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new CloudApiError(
      "云端接口返回了无效内容",
      "invalid-response",
      503,
    );
  }
  const body = await response.json().catch(() => {
    throw new CloudApiError(
      "云端接口返回了无效内容",
      "invalid-response",
      503,
    );
  });
  if (!response.ok) {
    throw new CloudApiError(
      body?.message || "云端服务暂时不可用，请稍后重试",
      body?.code || "request-failed",
      response.status,
    );
  }
  return body;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  return parseResponse(response);
}

function canUseLocalFallback(error) {
  return isLocalPreview() && (
    error instanceof TypeError
    || [404, 500, 501, 503].includes(error?.status)
  );
}

export async function registerCloudAccount(credentials) {
  try {
    const response = await request("/auth/register", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    return response.session;
  } catch (error) {
    if (canUseLocalFallback(error)) {
      return {
        ...(await registerLocalAccount(credentials)),
        storageMode: "local-preview",
      };
    }
    throw error;
  }
}

export async function loginCloudAccount(credentials) {
  try {
    const response = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    return response.session;
  } catch (error) {
    if (canUseLocalFallback(error)) {
      return {
        ...(await loginLocalAccount(credentials)),
        storageMode: "local-preview",
      };
    }
    throw error;
  }
}

export async function restoreCloudSession() {
  try {
    const response = await request("/auth/session");
    return response.session || null;
  } catch (error) {
    if (error?.status === 401) return null;
    if (canUseLocalFallback(error)) {
      const session = await restoreLocalSession();
      return session ? { ...session, storageMode: "local-preview" } : null;
    }
    throw error;
  }
}

export async function logoutCloudAccount() {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch (error) {
    if (!canUseLocalFallback(error)) throw error;
  } finally {
    if (isLocalPreview()) logoutLocalAccount();
  }
}

export async function listCloudAssets() {
  const response = await request("/library");
  return response.assets || [];
}

export async function uploadCloudAsset(file, kind) {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("kind", kind);
  const response = await request("/library/upload", {
    method: "POST",
    body: form,
  });
  return response.asset;
}

export async function deleteCloudAsset(id) {
  await request(`/library/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function cloudAssetUrl(id) {
  return `${API_ROOT}/library/${encodeURIComponent(id)}/file`;
}

export async function listCloudStyles() {
  const response = await request("/styles");
  return (response.styles || []).map((item) => ({
    ...deserializeClstyle(item.serialized),
    cloudUpdatedAt: item.updatedAt,
  }));
}

export async function saveCloudStyle(style) {
  const serialized = serializeClstyle(style);
  await request("/styles", {
    method: "PUT",
    body: JSON.stringify({
      id: style.id,
      name: style.name,
      serialized,
      createdAt: style.createdAt || Date.now(),
    }),
  });
  return style;
}

export async function deleteCloudStyle(id) {
  await request(`/styles/${encodeURIComponent(id)}`, { method: "DELETE" });
}
