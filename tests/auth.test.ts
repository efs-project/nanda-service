import { describe, expect, it } from "vitest";

import { authenticateApiKey, parseApiKeys } from "../src/auth/api-key.js";
import { deriveAttester } from "../src/auth/derived-attester.js";
import { canonicalSubject } from "../src/auth/subject.js";

describe("canonicalSubject", () => {
  it("normalizes authenticated subjects without using display IDs", () => {
    expect(canonicalSubject(" API-Key:Local-Scribe-Agent ")).toBe("api-key:local-scribe-agent");
  });
});

describe("authenticateApiKey", () => {
  it("maps API keys to authenticated subjects", () => {
    const keys = parseApiKeys('{"local-scribe-key":"api-key:local-scribe-agent"}');

    const auth = authenticateApiKey("local-scribe-key", keys, "agent:claimed-demo");

    expect(auth).toEqual({
      method: "api_key",
      authenticated_subject: "api-key:local-scribe-agent",
      claimed_nanda_id: "agent:claimed-demo",
      auth_level: "write_key",
      capabilities: {
        delete_files: false
      }
    });
  });

  it("allows API key grants to opt into file deletion", () => {
    const keys = parseApiKeys(
      '{"local-scribe-key":{"subject":"api-key:local-scribe-agent","allow_delete":true}}'
    );

    const auth = authenticateApiKey("local-scribe-key", keys);

    expect(auth.capabilities?.delete_files).toBe(true);
  });

  it("rejects unknown API keys", () => {
    const keys = parseApiKeys('{"local-scribe-key":"api-key:local-scribe-agent"}');

    expect(() => authenticateApiKey("wrong-key", keys)).toThrow(/Invalid API key/);
  });
});

describe("deriveAttester", () => {
  it("derives stable hidden wallet addresses from authenticated subjects", () => {
    const first = deriveAttester({
      subject: "api-key:local-scribe-agent",
      secret: "unit-test-secret",
      chainId: 11155111
    });
    const second = deriveAttester({
      subject: "api-key:local-scribe-agent",
      secret: "unit-test-secret",
      chainId: 11155111
    });
    const other = deriveAttester({
      subject: "api-key:other-agent",
      secret: "unit-test-secret",
      chainId: 11155111
    });

    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.address).toBe(second.address);
    expect(first.privateKey).toBe(second.privateKey);
    expect(first.address).not.toBe(other.address);
    expect(first.derivation).toBe("efs-scribe/sepolia/v1");
  });
});
