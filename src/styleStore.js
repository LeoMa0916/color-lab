const DATABASE_NAME = "color-engine-v4";
const STORE_NAME = "styles";
const LEGACY_KEY = "diaoseshi-styles";

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeTypedArray(value) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return {
    __clstyleTypedArray: value.constructor.name,
    data: bytesToBase64(bytes),
    length: value.length,
  };
}

function decodeTypedArray(value) {
  const bytes = base64ToBytes(value.data);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const constructors = {
    Float32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
  };
  const Constructor = constructors[value.__clstyleTypedArray];
  if (!Constructor) throw new Error(`不支持的数组类型：${value.__clstyleTypedArray}`);
  const output = new Constructor(copy);
  if (output.length !== value.length) throw new Error("风格文件数组长度不匹配");
  return output;
}

export function serializeClstyle(style) {
  const envelope = {
    format: "com.colorlab.clstyle",
    schemaVersion: 6,
    engine: "Color Engine 5.1",
    exportedAt: new Date().toISOString(),
    style,
  };
  return JSON.stringify(envelope, (_, value) => {
    if (
      value instanceof Float32Array
      || value instanceof Uint8Array
      || value instanceof Uint8ClampedArray
      || value instanceof Uint16Array
    ) return encodeTypedArray(value);
    return value;
  });
}

export function deserializeClstyle(text) {
  const envelope = JSON.parse(text, (_, value) =>
    value?.__clstyleTypedArray ? decodeTypedArray(value) : value);
  if (
    envelope?.format !== "com.colorlab.clstyle"
    || ![4, 5, 6].includes(envelope.schemaVersion)
    || !envelope.style?.stats
  ) {
    throw new Error("这不是有效的 Color Engine 4 / 5 / 5.1 风格文件");
  }
  return envelope.style;
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, action) {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function saveStyle(style) {
  await transact("readwrite", (store) => store.put(style));
  return style;
}

export async function deleteStyle(id) {
  await transact("readwrite", (store) => store.delete(id));
}

export async function loadStyles() {
  let styles = await transact("readonly", (store) => store.getAll());
  styles ||= [];
  if (!styles.length && typeof localStorage !== "undefined") {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
      if (Array.isArray(legacy) && legacy.length) {
        await Promise.all(legacy.map((style) => saveStyle({
          ...style,
          formatVersion: style.formatVersion || 3,
        })));
        styles = legacy;
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch {
      // Corrupt legacy entries must not prevent the editor from opening.
    }
  }
  return styles.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
}
