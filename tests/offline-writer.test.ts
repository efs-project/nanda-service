import { describe, expect, it } from "vitest";

import { authenticateApiKey, parseApiKeys } from "../src/auth/api-key.js";
import { deriveAttester } from "../src/auth/derived-attester.js";
import { OfflineEfsWriter } from "../src/efs/offline-writer.js";

const request = {
  path: "/agents/demo/status.json",
  content: {
    mode: "inline_base64" as const,
    content_base64: Buffer.from('{"ok":true}', "utf8").toString("base64"),
    content_type: "application/json"
  },
  mirrors: [],
  properties: {
    name: "status.json"
  },
  agent: {
    claimed_nanda_id: "agent:demo"
  },
  options: {
    idempotency_key: "demo-status-001"
  }
};

function contextFor(apiKey: string) {
  const auth = authenticateApiKey(
    apiKey,
    parseApiKeys('{"local-scribe-key":"api-key:local-scribe-agent","other-key":"api-key:other-agent"}'),
    request.agent.claimed_nanda_id
  );
  const attester = deriveAttester({
    subject: auth.authenticated_subject,
    secret: "unit-test-secret",
    chainId: 11155111
  });
  return { auth, attester, publicBaseUrl: "http://localhost:3000" };
}

describe("OfflineEfsWriter", () => {
  it("creates deterministic receipts for identical writes", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const first = await writer.writeFile(request, contextFor("local-scribe-key"));
    const second = await writer.writeFile(request, contextFor("local-scribe-key"));

    expect(first).toEqual(second);
    expect(first.mode).toBe("offline");
    expect(first.efs.network).toBe("offline");
    expect(first.efs.uids.data).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("creates deterministic receipts for identical removes", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const removeRequest = {
      path: "/agents/demo/status.json",
      agent: {
        claimed_nanda_id: "agent:demo"
      },
      options: {
        idempotency_key: "demo-status-delete-001"
      }
    };
    const first = await writer.removeFile(removeRequest, contextFor("local-scribe-key"));
    const second = await writer.removeFile(removeRequest, contextFor("local-scribe-key"));

    expect(first).toEqual(second);
    expect(first.mode).toBe("offline");
    expect(first.operation).toBe("file.remove");
    expect(first.efs.network).toBe("offline");
    expect(first.efs.path).toBe("/agents/demo/status.json");
    expect(first.efs.uids.placement_pin).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.efs.mirrors).toEqual([]);
  });

  it("changes the data uid when payload bytes change", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const first = await writer.writeFile(request, contextFor("local-scribe-key"));
    const changed = await writer.writeFile(
      {
        ...request,
        content: {
          ...request.content,
          content_base64: Buffer.from('{"ok":false}', "utf8").toString("base64")
        }
      },
      contextFor("local-scribe-key")
    );

    expect(first.efs.uids.data).not.toBe(changed.efs.uids.data);
  });

  it("changes the lens when authenticated subject changes", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const first = await writer.writeFile(request, contextFor("local-scribe-key"));
    const other = await writer.writeFile(request, contextFor("other-key"));

    expect(first.auth.claimed_nanda_id).toBe(other.auth.claimed_nanda_id);
    expect(first.auth.authenticated_subject).not.toBe(other.auth.authenticated_subject);
    expect(first.agent_lens.attester).not.toBe(other.agent_lens.attester);
  });

  it("verifies offline receipts with explicit checks", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const receipt = await writer.writeFile(request, contextFor("local-scribe-key"));
    const verification = await writer.verifyReceipt(receipt);

    expect(verification.ok).toBe(true);
    expect(verification.checks.map((check) => check.name)).toContain("offline_receipt_shape");
  });

  it("includes every planned property pin in offline receipts", async () => {
    const writer = new OfflineEfsWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const receipt = await writer.writeFile(request, contextFor("local-scribe-key"));

    expect(Object.keys(receipt.efs.uids.properties).sort()).toEqual([
      "contentHash",
      "contentType",
      "name",
      "size"
    ]);
  });
});
