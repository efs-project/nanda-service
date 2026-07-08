import { describe, expect, it } from "vitest";

import { ReceiptSchema } from "../src/receipts/schema.js";

describe("ReceiptSchema", () => {
  it("accepts an offline EFS Scribe receipt", () => {
    const parsed = ReceiptSchema.parse({
      receipt_version: "efs-scribe-receipt/v1",
      receipt_id: "rcpt_abc123",
      status: "confirmed",
      mode: "offline",
      operation: "file.upsert",
      created_at: "2026-07-08T00:00:00.000Z",
      auth: {
        method: "api_key",
        authenticated_subject: "api-key:local-scribe-agent",
        claimed_nanda_id: "agent:demo",
        auth_level: "write_key"
      },
      agent_lens: {
        attester: "0x0000000000000000000000000000000000000001",
        derivation: "efs-scribe/sepolia/v1"
      },
      integrity: {
        payload_sha256:
          "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
        metadata_sha256:
          "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
        canonical_request_sha256:
          "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
      },
      efs: {
        network: "offline",
        chain_id: 0,
        eas: null,
        tx_hashes: [],
        block_numbers: [],
        path: "/agents/demo/status.json",
        uids: {
          data: "0x1111111111111111111111111111111111111111111111111111111111111111",
          file_anchor: "0x2222222222222222222222222222222222222222222222222222222222222222",
          placement_pin: "0x3333333333333333333333333333333333333333333333333333333333333333",
          mirrors: [],
          properties: {
            contentHash:
              "0x4444444444444444444444444444444444444444444444444444444444444444"
          }
        }
      },
      verification: {
        checked_at: "2026-07-08T00:00:00.000Z",
        checks: [{ name: "offline_receipt_shape", ok: true }]
      }
    });

    expect(parsed.receipt_id).toBe("rcpt_abc123");
  });
});
