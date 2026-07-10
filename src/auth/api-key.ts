import { unauthorized } from "../lib/errors.js";
import { canonicalSubject, type AuthContext } from "./subject.js";

export interface ApiKeyGrant {
  subject: string;
  allowDelete: boolean;
}

export type ApiKeyMap = Map<string, ApiKeyGrant>;

export function parseApiKeys(json: string): ApiKeyMap {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("API_KEYS_JSON must be an object mapping API keys to subjects");
  }

  const keys: ApiKeyMap = new Map();
  for (const [apiKey, grant] of Object.entries(parsed)) {
    if (typeof grant === "string") {
      keys.set(apiKey, {
        subject: canonicalSubject(grant),
        allowDelete: false
      });
      continue;
    }
    if (grant === null || typeof grant !== "object" || Array.isArray(grant)) {
      throw new Error(`API key ${apiKey} must map to a string subject or grant object`);
    }
    const record = grant as Record<string, unknown>;
    if (typeof record.subject !== "string") {
      throw new Error(`API key ${apiKey} grant must include a string subject`);
    }
    if (record.allow_delete !== undefined && typeof record.allow_delete !== "boolean") {
      throw new Error(`API key ${apiKey} allow_delete must be a boolean`);
    }
    keys.set(apiKey, {
      subject: canonicalSubject(record.subject),
      allowDelete: record.allow_delete === true
    });
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

  const grant = keys.get(apiKey);
  if (grant === undefined) {
    throw unauthorized("Invalid API key");
  }

  return {
    method: "api_key",
    authenticated_subject: grant.subject,
    claimed_nanda_id: claimedNandaId,
    auth_level: "write_key",
    capabilities: {
      delete_files: grant.allowDelete
    }
  };
}
