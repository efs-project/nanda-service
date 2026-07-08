import { unauthorized } from "../lib/errors.js";
import { canonicalSubject, type AuthContext } from "./subject.js";

export type ApiKeyMap = Map<string, string>;

export function parseApiKeys(json: string): ApiKeyMap {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("API_KEYS_JSON must be an object mapping API keys to subjects");
  }

  const keys = new Map<string, string>();
  for (const [apiKey, subject] of Object.entries(parsed)) {
    if (typeof subject !== "string") {
      throw new Error(`API key ${apiKey} must map to a string subject`);
    }
    keys.set(apiKey, canonicalSubject(subject));
  }
  return keys;
}

export function authenticateApiKey(
  apiKey: string | undefined,
  keys: ApiKeyMap,
  claimedNandaId?: string
): AuthContext {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw unauthorized();
  }

  const subject = keys.get(apiKey);
  if (subject === undefined) {
    throw unauthorized("Invalid API key");
  }

  return {
    method: "api_key",
    authenticated_subject: subject,
    claimed_nanda_id: claimedNandaId,
    auth_level: "write_key"
  };
}
