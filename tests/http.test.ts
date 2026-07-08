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
  it("reports health and capabilities", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"demo-key":"api-key:demo-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mode: "offline" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      service: "efs-scribe",
      mode: "offline",
      receipt_version: "efs-scribe-receipt/v1"
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
      info: { title: "EFS Scribe API" }
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
});
