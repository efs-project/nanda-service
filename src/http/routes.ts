import { readFile } from "node:fs/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { authenticateApiKey, parseApiKeys } from "../auth/api-key.js";
import { deriveAttester } from "../auth/derived-attester.js";
import type { AppConfig } from "../config/env.js";
import { OfflineEfsWriter } from "../efs/offline-writer.js";
import { FileWriteRequestSchema } from "../efs/writer.js";
import { HttpError } from "../lib/errors.js";
import { ReceiptSchema } from "../receipts/schema.js";

export async function registerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const apiKeys = parseApiKeys(config.apiKeysJson);
  const writer = new OfflineEfsWriter();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof ZodError) {
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
      "/health": { get: { summary: "Healthcheck" } },
      "/SKILL.md": { get: { summary: "Agent-facing skill instructions" } },
      "/v1/capabilities": { get: { summary: "Service capabilities" } },
      "/v1/files": { post: { summary: "Write an EFS file record" } },
      "/v1/verify": { post: { summary: "Verify an EFS Scribe receipt" } }
    }
  }));

  app.get("/v1/capabilities", async () => ({
    service: "efs-scribe",
    mode: config.mode,
    receipt_version: "efs-scribe-receipt/v1",
    auth_modes: ["api_key"],
    writer_modes: ["offline", "sepolia"],
    writes_require_auth: true,
    public_endpoints: ["/health", "/v1/capabilities", "/v1/verify"]
  }));

  app.post("/v1/files", async (request: FastifyRequest, _reply: FastifyReply) => {
    const parsed = FileWriteRequestSchema.parse(request.body);
    const auth = authenticateApiKey(extractApiKey(request), apiKeys, parsed.agent.claimed_nanda_id);
    const attester = deriveAttester({
      subject: auth.authenticated_subject,
      secret: config.derivationSecret,
      chainId: config.chainId
    });
    const receipt = await writer.writeFile(parsed, {
      auth,
      attester,
      publicBaseUrl: config.publicBaseUrl
    });

    return {
      receipt,
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
