import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = normalize(item);
      }
    }
    return sorted;
  }

  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: unknown): `sha256:${string}` {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(value)) {
    hash.update(value);
  } else if (typeof value === "string") {
    hash.update(value, "utf8");
  } else {
    hash.update(canonicalJson(value), "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function toMockUid(...parts: unknown[]): `0x${string}` {
  return `0x${sha256Hex(parts).slice("sha256:".length, "sha256:".length + 64)}`;
}
