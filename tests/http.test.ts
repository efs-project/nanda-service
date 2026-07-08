import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";

const writeBody = {
  path: "/agents/demo/status.json",
  content: {
    mode: "inline_base64",
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
    idempotency_key: "demo-status-http-001"
  }
};

describe("HTTP API", () => {
  it("rejects Sepolia mode until the Sepolia writer is implemented", async () => {
    await expect(
      buildApp({
        mode: "sepolia",
        apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
        derivationSecret: "unit-test-secret",
        publicBaseUrl: "http://localhost:3000",
        logLevel: "silent"
      })
    ).rejects.toThrow(/Sepolia writer is not implemented/);
  });

  it("reports health, service links, and capabilities", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const root = await app.inject({ method: "GET", url: "/" });
    const health = await app.inject({ method: "GET", url: "/health" });
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });

    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({
      service: "efs-scribe",
      links: {
        skill: "/SKILL.md",
        openapi: "/openapi.json",
        capabilities: "/v1/capabilities"
      }
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mode: "offline" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      service: "efs-scribe",
      mode: "offline",
      receipt_version: "efs-scribe-receipt/v1",
      writer_modes: ["offline"],
      planned_writer_modes: ["sepolia"],
      sepolia_status: "not_implemented",
      sepolia_preflight: "implemented_read_only",
      sepolia_config: {
        ready: false,
        missing: [
          "SEPOLIA_RPC_URL",
          "SERVICE_SPONSOR_PRIVATE_KEY",
          "RECEIPT_SIGNER_PRIVATE_KEY",
          "AGENT_KEY_DERIVATION_SECRET"
        ]
      },
      efs: {
        sepolia: { chainId: 11155111 },
        schema_uids: {
          DATA: "0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c"
        }
      }
    });

    await app.close();
  });

  it("serves agent docs and a minimal OpenAPI document", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const skill = await app.inject({ method: "GET", url: "/SKILL.md" });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(skill.statusCode).toBe(200);
    expect(skill.headers["content-type"]).toContain("text/markdown");
    expect(skill.body).toContain("EFS Scribe");
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      openapi: "3.1.0",
      info: { title: "EFS Scribe API" },
      paths: {
        "/v1/files/plan": {
          post: {
            summary: "Preview an EFS file write plan"
          }
        }
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" }
        }
      }
    });

    await app.close();
  });

  it("requires auth for file writes", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      payload: writeBody
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthorized" });

    await app.close();
  });

  it("writes and verifies an offline receipt", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });

    expect(write.statusCode).toBe(200);
    const receipt = write.json().receipt;
    expect(receipt.status).toBe("confirmed");
    expect(receipt.mode).toBe("offline");

    const verify = await app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: { receipt }
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ ok: true });

    await app.close();
  });

  it("previews an EFS file plan without storing a receipt", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const plan = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });

    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      dry_run: true,
      plan: {
        operation: "file.upsert",
        path: "/agents/demo/status.json",
        layers: expect.arrayContaining([
          expect.objectContaining({ ref: "data" }),
          expect.objectContaining({ ref: "anchor:/agents/demo/status.json" }),
          expect.objectContaining({ ref: "property:contentHash.pin" }),
          expect.objectContaining({ ref: "placement.pin" })
        ])
      }
    });

    const unresolved = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
    });

    expect(unresolved.statusCode).toBe(404);

    await app.close();
  });

  it("treats dry_run file writes as non-persistent plan previews", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const dryRun = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: {
        ...writeBody,
        options: { ...writeBody.options, dry_run: true }
      }
    });

    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json()).toMatchObject({
      dry_run: true,
      plan: {
        path: "/agents/demo/status.json"
      }
    });
    expect(dryRun.json().receipt).toBeUndefined();

    const unresolved = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
    });

    expect(unresolved.statusCode).toBe(404);

    await app.close();
  });

  it("stores receipts and returns idempotent retries", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });

    const firstReceipt = first.json().receipt;
    const retryReceipt = retry.json().receipt;
    expect(retryReceipt).toEqual(firstReceipt);

    const stored = await app.inject({
      method: "GET",
      url: `/v1/receipts/${firstReceipt.receipt_id}`
    });

    expect(stored.statusCode).toBe(200);
    expect(stored.json().receipt).toEqual(firstReceipt);

    await app.close();
  });

  it("rejects idempotency key reuse for a different request", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: {
        ...writeBody,
        path: "/agents/demo/other.json"
      }
    });

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "conflict" });

    await app.close();
  });

  it("resolves the latest stored receipt by path", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer demo-key" },
      payload: writeBody
    });
    const receipt = write.json().receipt;

    const resolved = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      path: "/agents/demo/status.json",
      attester: receipt.agent_lens.attester,
      receipt_id: receipt.receipt_id,
      payload_sha256: receipt.integrity.payload_sha256,
      uids: receipt.efs.uids
    });

    await app.close();
  });

  it("returns 404 for missing receipts and unresolved paths", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const missingReceipt = await app.inject({
      method: "GET",
      url: "/v1/receipts/rcpt_missing"
    });
    const missingPath = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fmissing.json"
    });

    expect(missingReceipt.statusCode).toBe(404);
    expect(missingReceipt.json()).toMatchObject({ error: "not_found" });
    expect(missingPath.statusCode).toBe(404);
    expect(missingPath.json()).toMatchObject({ error: "not_found" });

    await app.close();
  });

  it("returns 400 for invalid resolve paths", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2F..%2Fstatus.json"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "bad_request" });

    await app.close();
  });
});
