import { describe, expect, it } from "vitest";

import { authenticateApiKey, parseApiKeys } from "../src/auth/api-key.js";
import { deriveAttester } from "../src/auth/derived-attester.js";
import { canonicalSubject } from "../src/auth/subject.js";

describe("canonicalSubject", () => {
  it("normalizes authenticated subjects without using display IDs", () => {
    expect(canonicalSubject(" API-Key:Demo-Agent ")).toBe("api-key:demo-agent");
  });
});

describe("authenticateApiKey", () => {
  it("maps API keys to authenticated subjects", () => {
    const keys = parseApiKeys('{"demo-key":"api-key:demo-agent"}');

    const auth = authenticateApiKey("demo-key", keys, "agent:claimed-demo");

    expect(auth).toEqual({
      method: "api_key",
      authenticated_subject: "api-key:demo-agent",
      claimed_nanda_id: "agent:claimed-demo",
      auth_level: "write_key"
    });
  });

  it("rejects unknown API keys", () => {
    const keys = parseApiKeys('{"demo-key":"api-key:demo-agent"}');

    expect(() => authenticateApiKey("wrong-key", keys)).toThrow(/Invalid API key/);
  });
});

describe("deriveAttester", () => {
  it("derives stable hidden wallet addresses from authenticated subjects", () => {
    const first = deriveAttester({
      subject: "api-key:demo-agent",
      secret: "unit-test-secret",
      chainId: 11155111
    });
    const second = deriveAttester({
      subject: "api-key:demo-agent",
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
