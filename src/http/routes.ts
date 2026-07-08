import { readFile } from "node:fs/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import type { ApiKeyMap } from "../auth/api-key.js";
import { authenticateApiKey, parseApiKeys } from "../auth/api-key.js";
import { deriveAttester } from "../auth/derived-attester.js";
import { EFS_SCHEMA_UIDS, EFS_SEPOLIA } from "../config/chains.js";
import type { AppConfig } from "../config/env.js";
import { OfflineEfsWriter } from "../efs/offline-writer.js";
import { EfsWritePlanError, normalizeEfsPath } from "../efs/write-plan.js";
import { FileWriteRequestSchema, type FileWriteRequest, type WriterContext } from "../efs/writer.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { InMemoryReceiptRepository } from "../receipts/repository.js";
import { ReceiptSchema } from "../receipts/schema.js";

export async function registerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const apiKeys = parseApiKeys(config.apiKeysJson);
  const writer = new OfflineEfsWriter();
  const receipts = new InMemoryReceiptRepository();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      void reply.status(400).send({ error: "bad_request", message: error.message });
      return;
    }
    if (error instanceof EfsWritePlanError) {
      void reply.status(400).send({ error: "bad_request", message: error.message });
      return;
    }
    void reply.status(500).send({ error: "internal_error", message: "Unexpected service error" });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "efs-scribe",
    mode: config.mode
  }));

  app.get("/", async () => ({
    service: "efs-scribe",
    mode: config.mode,
    summary: "Agent-friendly EFS file write receipts and write-plan previews.",
    links: {
      health: "/health",
      skill: "/SKILL.md",
      openapi: "/openapi.json",
      capabilities: "/v1/capabilities",
      plan_file: "/v1/files/plan",
      write_file: "/v1/files",
      verify_receipt: "/v1/verify"
    }
  }));

  app.get("/SKILL.md", async (_request, reply) => {
    const skill = await readFile("SKILL.md", "utf8");
    return reply.type("text/markdown; charset=utf-8").send(skill);
  });

  app.get("/openapi.json", async () => ({
    openapi: "3.1.0",
    info: {
      title: "EFS Scribe API",
      version: "0.1.0"
    },
    paths: {
      "/": { get: { summary: "Service index" } },
      "/health": { get: { summary: "Healthcheck" } },
      "/SKILL.md": { get: { summary: "Agent-facing skill instructions" } },
      "/v1/capabilities": { get: { summary: "Service capabilities" } },
      "/v1/files/plan": {
        post: {
          summary: "Preview an EFS file write plan",
          security: [{ bearerAuth: [] }]
        }
      },
      "/v1/files": {
        post: {
          summary: "Write an EFS file record",
          security: [{ bearerAuth: [] }]
        }
      },
      "/v1/receipts/{receiptId}": { get: { summary: "Fetch a stored receipt" } },
      "/v1/resolve": { get: { summary: "Resolve the latest stored receipt by path" } },
      "/v1/verify": { post: { summary: "Verify an EFS Scribe receipt" } }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas: {
        FileWriteRequest: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", example: "/agents/demo/status.json" },
            content: { type: "object" },
            mirrors: { type: "array", items: { type: "object" } },
            properties: { type: "object", additionalProperties: { type: "string" } },
            agent: { type: "object" },
            options: { type: "object" }
          }
        }
      }
    }
  }));

  app.get("/v1/capabilities", async () => ({
    service: "efs-scribe",
    mode: config.mode,
    receipt_version: "efs-scribe-receipt/v1",
    auth_modes: ["api_key"],
    writer_modes: ["offline"],
    planned_writer_modes: ["sepolia"],
    sepolia_status: "not_implemented",
    content_modes: ["inline_base64", "hash_only", "external_mirror_only"],
    writes_require_auth: true,
    efs: {
      sepolia: EFS_SEPOLIA,
      schema_uids: EFS_SCHEMA_UIDS
    },
    public_endpoints: [
      "/",
      "/health",
      "/SKILL.md",
      "/openapi.json",
      "/v1/capabilities",
      "/v1/receipts/:receiptId",
      "/v1/resolve",
      "/v1/verify"
    ],
    authenticated_endpoints: ["/v1/files/plan", "/v1/files"]
  }));

  app.post("/v1/files/plan", async (request: FastifyRequest) => {
    const parsed = FileWriteRequestSchema.parse(request.body);
    const context = writerContext(request, parsed, apiKeys, config);
    const plan = await writer.planFile(parsed, context);

    return planResponse(plan, config);
  });

  app.post("/v1/files", async (request: FastifyRequest, _reply: FastifyReply) => {
    const parsed = FileWriteRequestSchema.parse(request.body);
    const context = writerContext(request, parsed, apiKeys, config);
    const plan = await writer.planFile(parsed, context);
    if (parsed.options.dry_run) {
      return planResponse(plan, config);
    }

    const existing =
      parsed.options.idempotency_key === undefined
        ? undefined
        : await receipts.getByIdempotency(
            context.auth.authenticated_subject,
            parsed.options.idempotency_key
          );
    if (existing !== undefined) {
      if (existing.integrity.canonical_request_sha256 !== plan.canonicalRequestHash) {
        throw conflict("Idempotency key was already used for a different file write request");
      }
      return {
        receipt: existing,
        links: existing.links
      };
    }

    const receipt = await writer.submitPlan(plan, context);
    await receipts.save(receipt, {
      authenticatedSubject: context.auth.authenticated_subject,
      idempotencyKey: parsed.options.idempotency_key
    });

    return {
      receipt,
      links: receipt.links
    };
  });

  app.get("/v1/receipts/:receiptId", async (request: FastifyRequest) => {
    const { receiptId } = request.params as { receiptId: string };
    const receipt = await receipts.get(receiptId);
    if (receipt === undefined) {
      throw notFound("Receipt not found");
    }
    return { receipt, links: receipt.links };
  });

  app.get("/v1/resolve", async (request: FastifyRequest) => {
    const query = request.query as { path?: string; attester?: string };
    if (query.path === undefined) {
      throw badRequest("Missing required query parameter: path");
    }

    const path = normalizeEfsPath(query.path).canonicalPath;
    const receipt = await receipts.getLatestByPath(path, query.attester);
    if (receipt === undefined) {
      throw notFound("No receipt found for path");
    }

    return {
      path,
      attester: receipt.agent_lens.attester,
      receipt_id: receipt.receipt_id,
      payload_sha256: receipt.integrity.payload_sha256,
      uids: receipt.efs.uids,
      links: receipt.links
    };
  });

  app.post("/v1/verify", async (request: FastifyRequest) => {
    const body = request.body as { receipt?: unknown };
    const receipt = ReceiptSchema.parse(body.receipt);
    return writer.verifyReceipt(receipt);
  });
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  const header = request.headers["x-api-key"];
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

function writerContext(
  request: FastifyRequest,
  parsed: FileWriteRequest,
  apiKeys: ApiKeyMap,
  config: AppConfig
): WriterContext {
  const auth = authenticateApiKey(extractApiKey(request), apiKeys, parsed.agent.claimed_nanda_id);
  const attester = deriveAttester({
    subject: auth.authenticated_subject,
    secret: config.derivationSecret,
    chainId: config.chainId
  });

  return {
    auth,
    attester,
    publicBaseUrl: config.publicBaseUrl
  };
}

function planResponse(plan: unknown, config: AppConfig) {
  return {
    dry_run: true,
    plan,
    links: {
      submit: `${config.publicBaseUrl}/v1/files`,
      capabilities: `${config.publicBaseUrl}/v1/capabilities`
    }
  };
}
