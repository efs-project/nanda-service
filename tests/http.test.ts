import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { EFS_SEPOLIA, EFS_TRANSPORTS } from "../src/config/chains.js";
import { parseEnv, type AppConfig } from "../src/config/env.js";
import { OfflineEfsWriter } from "../src/efs/offline-writer.js";
import { SepoliaSubmitError } from "../src/efs/sepolia-writer.js";
import {
  EfsFileWriteConflictError,
  type EfsWritePlan,
  type EfsWriter,
  type WriterContext
} from "../src/efs/writer.js";
import { registerRoutes } from "../src/http/routes.js";
import type { EfsScribeReceipt } from "../src/receipts/schema.js";
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

const apiKeysWithDelete = '{"local-scribe-key":{"subject":"api-key:local-scribe-agent","allow_delete":true}}';

const removeBody = {
  path: "/agents/demo/status.json",
  agent: {
    claimed_nanda_id: "agent:demo"
  },
  options: {
    idempotency_key: "demo-status-delete-001"
  }
};

describe("HTTP API", () => {
  it("rejects Sepolia mode until required chain configuration is present", async () => {
    await expect(
      buildApp({
        mode: "sepolia",
        apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
        derivationSecret: "unit-test-secret",
        publicBaseUrl: "http://localhost:3000",
        logLevel: "silent"
      })
    ).rejects.toThrow(/Sepolia writer requires/);
  });

  it("rejects sample API keys in Sepolia mode", async () => {
    const config = parseEnv({
      EFS_SCRIBE_MODE: "sepolia",
      API_KEYS_JSON: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      AGENT_KEY_DERIVATION_SECRET: "realistic-non-default-derivation-secret",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: "3000",
      LOG_LEVEL: "silent",
      EFS_CHAIN_ID: "11155111",
      EFS_EAS_ADDRESS: EFS_SEPOLIA.eas,
      SEPOLIA_RPC_URL: "https://sepolia.example.test/rpc",
      SEPOLIA_AGENT_FUNDING_TARGET_WEI: "0",
      SERVICE_SPONSOR_PRIVATE_KEY: "",
      RECEIPT_SIGNER_PRIVATE_KEY: ""
    });

    await expect(buildApp(config)).rejects.toThrow(/replace the sample API key/i);
  });

  it("reports health, service links, and capabilities", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
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
        skill: "/skill.md",
        skill_canonical: "/SKILL.md",
        openapi: "/openapi.json",
        capabilities: "/v1/capabilities",
        delete_file: "/v1/files/delete"
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
      planned_writer_modes: [],
      sepolia_status: "missing_configuration",
      sepolia_preflight: "implemented_read_only",
      sepolia_config: {
        ready: false,
        missing: [
          "SEPOLIA_RPC_URL",
          "SERVICE_SPONSOR_PRIVATE_KEY",
          "AGENT_KEY_DERIVATION_SECRET"
        ],
        agent_funding_target_wei: "20000000000000000"
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
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const skill = await app.inject({ method: "GET", url: "/SKILL.md" });
    const lowercaseSkill = await app.inject({ method: "GET", url: "/skill.md" });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(skill.statusCode).toBe(200);
    expect(lowercaseSkill.statusCode).toBe(200);
    expect(skill.headers["content-type"]).toContain("text/markdown");
    expect(lowercaseSkill.headers["content-type"]).toContain("text/markdown");
    expect(lowercaseSkill.body).toEqual(skill.body);
    expect(skill.body).toContain("EFS Scribe");
    expect(skill.body).toContain("https://efs-scribe-production.up.railway.app");
    expect(skill.body).toContain("EFS_SCRIBE_API_KEY");
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      openapi: "3.1.0",
      info: { title: "EFS Scribe API" },
      paths: {
        "/v1/files/plan": {
          post: {
            summary: "Preview an EFS file write plan",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileWriteRequest" }
                }
              }
            }
          }
        },
        "/v1/verify": {
          post: {
            description:
              "Checks receipt shape and self-consistency. This is not an independent Sepolia indexer."
          }
        },
        "/v1/files/delete": {
          post: {
            summary: "Remove an EFS file placement from the authenticated agent lens"
          }
        },
        "/skill.md": {
          get: {
            summary: "Agent-facing skill instructions"
          }
        }
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" }
        },
        schemas: {
          FileWriteRequest: {
            properties: {
              content: {
                oneOf: [
                  { $ref: "#/components/schemas/InlineContent" },
                  { $ref: "#/components/schemas/HashOnlyContent" },
                  { $ref: "#/components/schemas/ExternalMirrorOnlyContent" }
                ]
              },
              mirrors: {
                items: { $ref: "#/components/schemas/Mirror" }
              }
            }
          },
          Mirror: {
            properties: {
              transport: { enum: [...EFS_TRANSPORTS] }
            }
          },
          FileRemoveRequest: {
            required: ["path"]
          },
          VerifyReceiptRequest: {
            required: ["receipt"]
          }
        }
      }
    });

    await app.close();
  });

  it("requires auth for file writes and removals", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      payload: writeBody
    });
    const remove = await app.inject({
      method: "POST",
      url: "/v1/files/delete",
      payload: removeBody
    });

    expect(write.statusCode).toBe(401);
    expect(write.json()).toMatchObject({ error: "unauthorized" });
    expect(remove.statusCode).toBe(401);
    expect(remove.json()).toMatchObject({ error: "unauthorized" });

    await app.close();
  });

  it("rejects unauthenticated write requests before body validation", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": "application/json" },
      payload: "{"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthorized" });

    await app.close();
  });

  it("writes and verifies an offline receipt", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
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

  it("removes and verifies an offline receipt", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: apiKeysWithDelete,
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const remove = await app.inject({
      method: "POST",
      url: "/v1/files/delete",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: removeBody
    });

    expect(remove.statusCode).toBe(200);
    const receipt = remove.json().receipt;
    expect(receipt).toMatchObject({
      status: "confirmed",
      mode: "offline",
      operation: "file.remove",
      efs: {
        path: "/agents/demo/status.json",
        mirrors: []
      }
    });

    const retry = await app.inject({
      method: "POST",
      url: "/v1/files/delete",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: removeBody
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().receipt).toEqual(receipt);

    const verify = await app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: { receipt }
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ ok: true });

    const resolved = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      operation: "file.remove",
      receipt_id: receipt.receipt_id,
      mirrors: []
    });

    await app.close();
  });

  it("rejects file removal for write-only API keys", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const remove = await app.inject({
      method: "POST",
      url: "/v1/files/delete",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: removeBody
    });

    expect(remove.statusCode).toBe(403);
    expect(remove.json()).toMatchObject({ error: "forbidden" });

    await app.close();
  });

  it("previews an EFS file plan without storing a receipt", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const plan = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
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

  it("adds an IPFS mirror for inline content when IPFS pinning is configured", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url, authorization: "Bearer fake-ipfs-token" }
    });

    const plan = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(plan.statusCode).toBe(200);
    expect(ipfs.requests).toHaveLength(1);
    expect(ipfs.requests[0]?.url).toContain("only-hash=true");
    expect(ipfs.requests[0]?.url).toContain("pin=false");
    expect(plan.json().plan.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "mirror.0",
          fields: expect.objectContaining({
            transport: "ipfs",
            uri: "ipfs://bafybeihackathon"
          })
        })
      ])
    );

    await app.close();
    await ipfs.close();
  });

  it("pins inline content to IPFS before writing by default", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url, authorization: "Bearer fake-ipfs-token" }
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(write.statusCode).toBe(200);
    expect(ipfs.requests).toHaveLength(1);
    expect(ipfs.requests[0]?.url).not.toContain("only-hash=true");
    expect(ipfs.requests[0]?.url).toContain("pin=true");
    expect(ipfs.requests[0]?.authorization).toBe("Bearer fake-ipfs-token");
    expect(write.json().receipt.efs.uids.mirrors).toHaveLength(1);
    expect(write.json().receipt.efs.mirrors).toEqual([
      { transport: "ipfs", uri: "ipfs://bafybeihackathon" }
    ]);

    await app.close();
    await ipfs.close();
  });

  it("returns idempotent retries without re-pinning to IPFS", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().receipt).toEqual(first.json().receipt);
    expect(ipfs.requests).toHaveLength(1);

    await app.close();
    await ipfs.close();
  });

  it("rejects requests that would exceed mirror limits before pinning", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        mirrors: Array.from({ length: 8 }, (_, index) => ({
          transport: "https",
          uri: `https://example.com/${index}.json`
        })),
        options: { ...writeBody.options, storage: "ipfs" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(ipfs.requests).toHaveLength(0);

    await app.close();
    await ipfs.close();
  });

  it("rejects reserved property conflicts before pinning", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        properties: {
          ...writeBody.properties,
          contentHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        },
        options: { ...writeBody.options, storage: "ipfs" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(ipfs.requests).toHaveLength(0);

    await app.close();
    await ipfs.close();
  });

  it("reports invalid IPFS configuration as an IPFS service error", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: "not a url" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        options: { ...writeBody.options, storage: "ipfs" }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "ipfs_pin_error",
      message: "IPFS API URL is invalid"
    });

    await app.close();
  });

  it("does not consume rate-limit tokens for invalid IPFS configuration", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: "not a url" }
    });

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/files",
          headers: { authorization: "Bearer local-scribe-key" },
          payload: {
            ...writeBody,
            path: `/agents/demo/invalid-ipfs-${index}.json`,
            options: {
              ...writeBody.options,
              idempotency_key: `invalid-ipfs-${index}`,
              storage: "ipfs"
            }
          }
        })
      );
    }

    expect(responses.every((response) => response.statusCode === 503)).toBe(true);
    expect(responses.every((response) => response.json().error === "ipfs_pin_error")).toBe(true);

    await app.close();
  });

  it("does not expose upstream IPFS error bodies", async () => {
    const ipfs = await startFakeIpfs({
      finalStatus: 400,
      finalBody: '{"secret":"internal proxy detail"}'
    });
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/plan",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        options: { ...writeBody.options, storage: "ipfs" }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("IPFS add failed with HTTP 400");
    expect(response.body).not.toContain("internal proxy detail");

    await app.close();
    await ipfs.close();
  });

  it("retries transient IPFS add failures", async () => {
    const ipfs = await startFakeIpfs({ failuresBeforeSuccess: 2 });
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(write.statusCode).toBe(200);
    expect(ipfs.requests).toHaveLength(3);

    await app.close();
    await ipfs.close();
  });

  it("rate limits IPFS operations per authenticated actor", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/files/plan",
          headers: { authorization: "Bearer local-scribe-key" },
          payload: {
            ...writeBody,
            path: `/agents/demo/rate-${index}.json`,
            options: {
              ...writeBody.options,
              idempotency_key: `rate-limit-${index}`,
              storage: "ipfs"
            }
          }
        })
      );
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    expect(responses[10]?.json()).toMatchObject({ error: "rate_limited" });
    expect(ipfs.requests).toHaveLength(10);

    await app.close();
    await ipfs.close();
  });

  it("rate limits file writes per authenticated actor", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/files",
          headers: { authorization: "Bearer local-scribe-key" },
          payload: {
            ...writeBody,
            path: `/agents/demo/write-rate-${index}.json`,
            options: {
              ...writeBody.options,
              idempotency_key: `write-rate-limit-${index}`
            }
          }
        })
      );
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    expect(responses[10]?.json()).toMatchObject({ error: "rate_limited" });

    await app.close();
  });

  it("lets callers skip service-side IPFS pinning for inline content", async () => {
    const ipfs = await startFakeIpfs();
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent",
      ipfs: { apiUrl: ipfs.url }
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        options: { ...writeBody.options, storage: "metadata_only" }
      }
    });

    expect(write.statusCode).toBe(200);
    expect(ipfs.requests).toHaveLength(0);
    expect(write.json().receipt.efs.uids.mirrors).toHaveLength(0);
    expect(write.json().receipt.efs.mirrors).toEqual([]);

    await app.close();
    await ipfs.close();
  });

  it("returns a service error when explicit IPFS pinning is unavailable", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: {
        ...writeBody,
        options: { ...writeBody.options, storage: "ipfs" }
      }
    });

    expect(write.statusCode).toBe(503);
    expect(write.json()).toMatchObject({ error: "ipfs_pin_error" });

    await app.close();
  });

  it("treats dry_run file writes as non-persistent plan previews", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const dryRun = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
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
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
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

  it("deduplicates concurrent writes with the same idempotency key before submitting", async () => {
    const writer = new SlowOfflineWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const app = await appWithWriter(writer);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/files",
        headers: { authorization: "Bearer local-scribe-key" },
        payload: writeBody
      }),
      app.inject({
        method: "POST",
        url: "/v1/files",
        headers: { authorization: "Bearer local-scribe-key" },
        payload: writeBody
      })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().receipt).toEqual(second.json().receipt);
    expect(writer.submitCount).toBe(1);

    await app.close();
  });

  it("deduplicates concurrent removals with the same idempotency key before submitting", async () => {
    const writer = new SlowOfflineWriter({ now: () => new Date("2026-07-08T00:00:00Z") });
    const app = await appWithWriter(writer);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/files/delete",
        headers: { authorization: "Bearer local-scribe-key" },
        payload: removeBody
      }),
      app.inject({
        method: "POST",
        url: "/v1/files/delete",
        headers: { authorization: "Bearer local-scribe-key" },
        payload: removeBody
      })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().receipt).toEqual(second.json().receipt);
    expect(writer.removeCount).toBe(1);

    await app.close();
  });

  it("rejects idempotency key reuse for a different request", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
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
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
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
      mirrors: receipt.efs.mirrors,
      uids: receipt.efs.uids
    });

    await app.close();
  });

  it("returns 404 for missing receipts and unresolved paths", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
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
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
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

  it("returns 400 for malformed public resolve and verify requests", async () => {
    const app = await buildApp({
      mode: "offline",
      apiKeysJson: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      derivationSecret: "unit-test-secret",
      publicBaseUrl: "http://localhost:3000",
      logLevel: "silent"
    });

    const duplicatePath = await app.inject({
      method: "GET",
      url: "/v1/resolve?path=%2Fagents%2Fdemo%2Fone.json&path=%2Fagents%2Fdemo%2Ftwo.json"
    });
    const missingReceipt = await app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: {}
    });
    const nullBody = await app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: { "content-type": "application/json" },
      payload: "null"
    });

    expect(duplicatePath.statusCode).toBe(400);
    expect(missingReceipt.statusCode).toBe(400);
    expect(nullBody.statusCode).toBe(400);

    await app.close();
  });

  it("reports Sepolia dependency failures as service errors", async () => {
    const app = await appWithWriter(new ThrowingSepoliaWriter());

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "sepolia_write_error" });

    await app.close();
  });

  it("reports active file placement write conflicts as client conflicts", async () => {
    const app = await appWithWriter(new ConflictingSepoliaWriter());

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { authorization: "Bearer local-scribe-key" },
      payload: writeBody
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "conflict" });

    await app.close();
  });
});

const testConfig: AppConfig = {
  mode: "offline",
  apiKeysJson: apiKeysWithDelete,
  derivationSecret: "unit-test-secret",
  publicBaseUrl: "http://localhost:3000",
  port: 3000,
  logLevel: "silent",
  chainId: 11155111,
  ipfs: {},
  sepolia: {
    ready: false,
    missing: [],
    easAddress: EFS_SEPOLIA.eas,
    agentFundingTargetWei: 0n
  }
};

async function appWithWriter(writer: EfsWriter) {
  const app = Fastify({ logger: false });
  await registerRoutes(app, testConfig, writer);
  return app;
}

class SlowOfflineWriter extends OfflineEfsWriter {
  submitCount = 0;
  removeCount = 0;

  override async submitPlan(
    plan: EfsWritePlan,
    context: WriterContext
  ): Promise<EfsScribeReceipt> {
    this.submitCount += 1;
    if (this.submitCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return super.submitPlan(plan, context);
  }

  override async removeFile(
    input: Parameters<OfflineEfsWriter["removeFile"]>[0],
    context: WriterContext
  ): Promise<EfsScribeReceipt> {
    this.removeCount += 1;
    if (this.removeCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return super.removeFile(input, context);
  }
}

class ThrowingSepoliaWriter extends OfflineEfsWriter {
  override async submitPlan(): Promise<EfsScribeReceipt> {
    throw new SepoliaSubmitError("Sepolia RPC unavailable");
  }
}

class ConflictingSepoliaWriter extends OfflineEfsWriter {
  override async submitPlan(): Promise<EfsScribeReceipt> {
    throw new EfsFileWriteConflictError(
      "An active EFS file placement already exists at this path for this agent lens"
    );
  }
}

interface FakeIpfsServer {
  url: string;
  requests: Array<{ url: string; bodyBytes: number; authorization?: string }>;
  close: () => Promise<void>;
}

async function startFakeIpfs(
  options: { failuresBeforeSuccess?: number; finalStatus?: number; finalBody?: string } = {}
): Promise<FakeIpfsServer> {
  const requests: FakeIpfsServer["requests"] = [];
  const server: Server = createServer((request, response) => {
    let bodyBytes = 0;
    request.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
    });
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        bodyBytes,
        authorization: request.headers.authorization
      });
      if (requests.length <= (options.failuresBeforeSuccess ?? 0)) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"Message":"temporary unavailable"}\n');
        return;
      }
      if (options.finalStatus !== undefined && options.finalStatus !== 200) {
        response.writeHead(options.finalStatus, { "content-type": "application/json" });
        response.end(options.finalBody ?? '{"Message":"failed"}\n');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"Name":"status.json","Hash":"bafybeihackathon","Size":"11"}\n');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/api/v0`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      })
  };
}
