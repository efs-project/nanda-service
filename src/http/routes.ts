import { readFile } from "node:fs/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import type { ApiKeyMap } from "../auth/api-key.js";
import { authenticateApiKey, parseApiKeys } from "../auth/api-key.js";
import { deriveAttester } from "../auth/derived-attester.js";
import { EFS_SCHEMA_UIDS, EFS_SEPOLIA, EFS_TRANSPORTS } from "../config/chains.js";
import type { AppConfig } from "../config/env.js";
import { SepoliaPreflightError } from "../efs/sepolia-preflight.js";
import { SepoliaSubmitError } from "../efs/sepolia-writer.js";
import { EfsWritePlanError, normalizeEfsPath } from "../efs/write-plan.js";
import {
  EfsFileRemoveError,
  EfsFileWriteConflictError,
  FileRemoveRequestSchema,
  FileWriteRequestSchema,
  type EfsWritePlan,
  type EfsWriter,
  type FileRemoveRequest,
  type FileWriteRequest,
  MAX_INLINE_CONTENT_BYTES,
  type StorageStrategy,
  type WriterContext
} from "../efs/writer.js";
import { sha256Hex } from "../lib/hash.js";
import {
  badGateway,
  badRequest,
  bytesUnavailable,
  conflict,
  forbidden,
  HttpError,
  notFound,
  payloadTooLarge,
  rateLimited
} from "../lib/errors.js";
import { InMemoryReceiptRepository } from "../receipts/repository.js";
import { ReceiptSchema, type EfsScribeReceipt } from "../receipts/schema.js";
import {
  addToIpfs,
  assertValidIpfsApiUrl,
  IpfsPinningError,
  IpfsReadError,
  readFromIpfs
} from "../storage/ipfs.js";

const IPFS_UPLOAD_RATE_LIMIT_CAPACITY = 10;
const IPFS_UPLOAD_RATE_LIMIT_REFILL_TOKENS = 5;
const IPFS_UPLOAD_RATE_LIMIT_REFILL_MS = 60_000;
const IPFS_MAX_CONCURRENT_ADDS = 2;
const WRITE_RATE_LIMIT_CAPACITY = 10;
const WRITE_RATE_LIMIT_REFILL_TOKENS = 5;
const WRITE_RATE_LIMIT_REFILL_MS = 60_000;

const ResolveQuerySchema = z.object({
  path: z.string().min(1),
  attester: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()
});
const ByteReadQuerySchema = ResolveQuerySchema;
const ByteWriteQuerySchema = z.object({
  path: z.string().min(1)
});
const ByteStorageHeaderSchema = z.enum(["auto", "ipfs", "metadata_only"]);

const VerifyReceiptBodySchema = z.object({
  receipt: ReceiptSchema
});

interface SubmissionResult {
  receipt: EfsScribeReceipt;
  error?: SepoliaSubmitError;
}

interface PendingIdempotentSubmission {
  originalRequestHash: string;
  result: Promise<SubmissionResult>;
}

export async function registerRoutes(
  app: FastifyInstance,
  config: AppConfig,
  writer: EfsWriter
): Promise<void> {
  const apiKeys = parseApiKeys(config.apiKeysJson);
  const receipts = new InMemoryReceiptRepository();
  const pendingIdempotentSubmissions = new Map<string, PendingIdempotentSubmission>();
  const writeRateLimiter = new TokenBucketRateLimiter({
    capacity: WRITE_RATE_LIMIT_CAPACITY,
    refillTokens: WRITE_RATE_LIMIT_REFILL_TOKENS,
    refillIntervalMs: WRITE_RATE_LIMIT_REFILL_MS
  }, "File write/remove rate limit exceeded");
  const ipfsRateLimiter = new TokenBucketRateLimiter({
    capacity: IPFS_UPLOAD_RATE_LIMIT_CAPACITY,
    refillTokens: IPFS_UPLOAD_RATE_LIMIT_REFILL_TOKENS,
    refillIntervalMs: IPFS_UPLOAD_RATE_LIMIT_REFILL_MS
  }, "IPFS upload rate limit exceeded");
  const ipfsAddSemaphore = new AsyncSemaphore(IPFS_MAX_CONCURRENT_ADDS);

  app.addHook("onRequest", async (request) => {
    if (isAuthenticatedWriteRoute(request.method, request.url)) {
      authenticateApiKey(extractApiKey(request), apiKeys);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 413) {
      void reply.status(413).send({ error: "payload_too_large", message: "Request body is too large" });
      return;
    }
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
    if (error instanceof EfsFileRemoveError) {
      void reply.status(404).send({ error: "not_found", message: error.message });
      return;
    }
    if (error instanceof EfsFileWriteConflictError) {
      void reply.status(409).send({ error: "conflict", message: error.message });
      return;
    }
    if (error instanceof SepoliaPreflightError || error instanceof SepoliaSubmitError) {
      void reply.status(503).send(sepoliaErrorBody(error));
      return;
    }
    if (error instanceof IpfsPinningError) {
      void reply.status(503).send({ error: "ipfs_pin_error", message: error.message });
      return;
    }
    if (error instanceof IpfsReadError) {
      void reply.status(502).send({ error: "ipfs_read_error", message: error.message });
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
    summary: "Agent-friendly EFS file bytes, receipts, and write-plan previews.",
    links: {
      health: "/health",
      skill: "/skill.md",
      skill_canonical: "/SKILL.md",
      openapi: "/openapi.json",
      capabilities: "/v1/capabilities",
      read_file_bytes: "/v1/files?path=/agents/demo/status.json",
      write_file_bytes: "/v1/files?path=/agents/demo/status.json",
      plan_file: "/v1/files/plan",
      write_file: "/v1/files",
      delete_file: "/v1/files/delete",
      verify_receipt: "/v1/verify"
    }
  }));

  app.get("/SKILL.md", async (_request, reply) => {
    const skill = await readFile("SKILL.md", "utf8");
    return reply.type("text/markdown; charset=utf-8").send(skill);
  });

  app.get("/skill.md", async (_request, reply) => {
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
      "/skill.md": { get: { summary: "Agent-facing skill instructions" } },
      "/v1/capabilities": { get: { summary: "Service capabilities" } },
      "/v1/files/plan": {
        post: {
          operationId: "planFileRecord",
          summary: "Preview an EFS file write plan",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileWriteRequest" }
              }
            }
          }
        }
      },
      "/v1/files": {
        get: {
          operationId: "readFileBytes",
          summary: "Read file bytes by EFS path",
          parameters: [
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string", example: "/agents/demo/status.json" }
            },
            {
              name: "attester",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }
            }
          ],
          responses: {
            "200": {
              description: "Verified file bytes fetched from an EFS mirror",
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" }
                }
              }
            }
          }
        },
        put: {
          operationId: "writeFileBytes",
          summary: "Write raw file bytes to an EFS path",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string", example: "/agents/demo/status.json" }
            },
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 128 }
            },
            {
              name: "X-EFS-Storage",
              in: "header",
              required: false,
              schema: { type: "string", enum: ["auto", "ipfs", "metadata_only"], default: "ipfs" }
            },
            {
              name: "X-Nanda-Agent",
              in: "header",
              required: false,
              schema: { type: "string", example: "agent:demo" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" }
              },
              "application/json": {
                schema: { type: "string", format: "binary" }
              }
            }
          },
          responses: {
            "200": {
              description: "Receipt for the EFS byte write",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ByteWriteResponse" }
                }
              }
            }
          }
        },
        post: {
          operationId: "writeFileRecord",
          summary: "Write an EFS file record",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileWriteRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "Receipt for the EFS write",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileWriteResponse" }
                }
              }
            }
          }
        }
      },
      "/v1/files/delete": {
        post: {
          operationId: "deleteFilePlacement",
          summary: "Remove an EFS file placement from the authenticated agent lens",
          description:
            "Revokes the authenticated agent's active placement PIN for a file path. Chain history, anchors, DATA, mirrors, and IPFS pins are not erased.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileRemoveRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "Receipt for the EFS removal",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileWriteResponse" }
                }
              }
            }
          }
        }
      },
      "/v1/receipts/{receiptId}": { get: { operationId: "getReceipt", summary: "Fetch a stored receipt" } },
      "/v1/resolve": { get: { operationId: "resolveFileReceipt", summary: "Resolve the latest stored receipt by path" } },
      "/v1/verify": {
        post: {
          operationId: "verifyReceipt",
          summary: "Verify an EFS Scribe receipt",
          description:
            "Checks receipt shape and self-consistency. This is not an independent Sepolia indexer.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VerifyReceiptRequest" }
              }
            }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" }
      },
      schemas: {
        InlineContent: {
          type: "object",
          required: ["mode", "content_base64", "content_type"],
          properties: {
            mode: { const: "inline_base64" },
            content_base64: { type: "string", example: "eyJvayI6dHJ1ZX0=" },
            content_type: { type: "string", example: "application/json" }
          }
        },
        HashOnlyContent: {
          type: "object",
          required: ["mode", "payload_sha256"],
          properties: {
            mode: { const: "hash_only" },
            payload_sha256: {
              type: "string",
              example: "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602"
            },
            size_bytes: { type: "integer", minimum: 0 },
            content_type: { type: "string", example: "application/json" }
          }
        },
        ExternalMirrorOnlyContent: {
          type: "object",
          required: ["mode", "payload_sha256"],
          properties: {
            mode: { const: "external_mirror_only" },
            payload_sha256: {
              type: "string",
              example: "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602"
            },
            size_bytes: { type: "integer", minimum: 0 },
            content_type: { type: "string", example: "application/json" }
          }
        },
        Mirror: {
          type: "object",
          required: ["transport", "uri"],
          properties: {
            transport: { type: "string", enum: [...EFS_TRANSPORTS] },
            uri: { type: "string", example: "https://example.com/status.json" }
          }
        },
        FileWriteRequest: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", example: "/agents/demo/status.json" },
            content: {
              oneOf: [
                { $ref: "#/components/schemas/InlineContent" },
                { $ref: "#/components/schemas/HashOnlyContent" },
                { $ref: "#/components/schemas/ExternalMirrorOnlyContent" }
              ]
            },
            mirrors: {
              type: "array",
              maxItems: 8,
              items: { $ref: "#/components/schemas/Mirror" }
            },
            properties: { type: "object", additionalProperties: { type: "string" } },
            agent: {
              type: "object",
              properties: {
                claimed_nanda_id: { type: "string", example: "agent:demo" },
                label: { type: "string" }
              }
            },
            options: {
              type: "object",
              properties: {
                dry_run: { type: "boolean", default: false },
                idempotency_key: { type: "string", maxLength: 128 },
                storage: {
                  type: "string",
                  enum: ["auto", "ipfs", "metadata_only"],
                  default: "auto",
                  description:
                    "For inline_base64 content, auto pins to IPFS when configured, ipfs requires service-side pinning, and metadata_only skips service-side pinning."
                }
              }
            }
          }
        },
        FileWriteResponse: {
          type: "object",
          required: ["receipt", "links"],
          properties: {
            receipt: { type: "object", description: "EFS Scribe receipt object" },
            links: { type: "object", additionalProperties: { type: "string" } }
          }
        },
        ByteWriteResponse: {
          type: "object",
          required: [
            "ok",
            "path",
            "content_type",
            "size_bytes",
            "payload_sha256",
            "receipt_id",
            "receipt",
            "links"
          ],
          properties: {
            ok: { type: "boolean", const: true },
            path: { type: "string", example: "/agents/demo/status.json" },
            content_type: { type: "string", example: "application/json" },
            size_bytes: { type: "integer", minimum: 0 },
            payload_sha256: {
              type: "string",
              example: "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602"
            },
            receipt_id: { type: "string", example: "rcpt_abc123" },
            receipt: { type: "object", description: "EFS Scribe receipt object" },
            links: { type: "object", additionalProperties: { type: "string" } }
          }
        },
        FileRemoveRequest: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", example: "/agents/demo/status.json" },
            agent: {
              type: "object",
              properties: {
                claimed_nanda_id: { type: "string", example: "agent:demo" },
                label: { type: "string" }
              }
            },
            options: {
              type: "object",
              properties: {
                idempotency_key: { type: "string", maxLength: 128 }
              }
            }
          }
        },
        VerifyReceiptRequest: {
          type: "object",
          required: ["receipt"],
          properties: {
            receipt: { type: "object", description: "Receipt returned by POST /v1/files" }
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
    writer_modes: config.mode === "sepolia" ? ["offline", "sepolia"] : ["offline"],
    planned_writer_modes: [],
    sepolia_status: config.sepolia.ready ? "available_when_configured" : "missing_configuration",
    sepolia_preflight: "implemented_read_only",
    sepolia_config: {
      ready: config.sepolia.ready,
      missing: config.sepolia.missing,
      agent_funding_target_wei: config.sepolia.agentFundingTargetWei.toString()
    },
    content_modes: ["inline_base64", "hash_only", "external_mirror_only"],
    byte_api: {
      write: "PUT /v1/files?path=<absolute-path>",
      read: "GET /v1/files?path=<absolute-path>",
      write_default_storage: "ipfs",
      read_verifies_payload_sha256: true
    },
    inline_content_limit_bytes: MAX_INLINE_CONTENT_BYTES,
    storage: {
      strategies: ["auto", "ipfs", "metadata_only"],
      default_for_inline_base64: config.ipfs.apiUrl === undefined ? "metadata_only" : "ipfs",
      ipfs: {
        configured: config.ipfs.apiUrl !== undefined,
        gateway_configured: config.ipfs.gatewayUrl !== undefined || config.ipfs.apiUrl !== undefined,
        mirror_transport: "ipfs",
        plan_previews_pin: false,
        rate_limit: {
          capacity: IPFS_UPLOAD_RATE_LIMIT_CAPACITY,
          refill_tokens: IPFS_UPLOAD_RATE_LIMIT_REFILL_TOKENS,
          refill_interval_ms: IPFS_UPLOAD_RATE_LIMIT_REFILL_MS
        },
        max_concurrent_adds: IPFS_MAX_CONCURRENT_ADDS
      }
    },
    write_rate_limit: {
      capacity: WRITE_RATE_LIMIT_CAPACITY,
      refill_tokens: WRITE_RATE_LIMIT_REFILL_TOKENS,
      refill_interval_ms: WRITE_RATE_LIMIT_REFILL_MS
    },
    writes_require_auth: true,
    deletes_require_delete_enabled_key: true,
    efs: {
      sepolia: EFS_SEPOLIA,
      schema_uids: EFS_SCHEMA_UIDS
    },
    public_endpoints: [
      "/",
      "/health",
      "/skill.md",
      "/SKILL.md",
      "/openapi.json",
      "/v1/capabilities",
      "GET /v1/files?path=<absolute-path>",
      "/v1/receipts/:receiptId",
      "/v1/resolve",
      "/v1/verify"
    ],
    authenticated_endpoints: [
      "PUT /v1/files?path=<absolute-path>",
      "/v1/files/plan",
      "/v1/files",
      "/v1/files/delete"
    ]
  }));

  await app.register(async (rawApp: FastifyInstance) => {
    const rawBodyParser = (
      _request: FastifyRequest,
      body: Buffer,
      done: (error: Error | null, body?: Buffer) => void
    ) => {
      done(null, body);
    };
    rawApp.removeContentTypeParser("application/json");
    rawApp.addContentTypeParser("application/json", {
      parseAs: "buffer",
      bodyLimit: MAX_INLINE_CONTENT_BYTES
    }, rawBodyParser);
    rawApp.addContentTypeParser("*", {
      parseAs: "buffer",
      bodyLimit: MAX_INLINE_CONTENT_BYTES
    }, rawBodyParser);

    rawApp.put("/v1/files", { bodyLimit: MAX_INLINE_CONTENT_BYTES }, async (request, reply) => {
      const query = ByteWriteQuerySchema.parse(request.query);
      const bytes = requestBodyBuffer(request.body);
      const contentType = requestContentType(request);
      const parsed = rawBytesWriteRequest({
        bytes,
        contentType,
        idempotencyKey: singleHeader(request.headers["idempotency-key"]),
        path: query.path,
        claimedNandaId: singleHeader(request.headers["x-nanda-agent"]),
        storage: parseStorageHeader(singleHeader(request.headers["x-efs-storage"]))
      });
      const context = writerContext(request, parsed, apiKeys, config);
      const submission = await writeWithOptionalIdempotency({
        parsed,
        config,
        receipts,
        pendingIdempotentSubmissions,
        writer,
        context,
        writeRateLimiter,
        ipfsRateLimiter,
        ipfsAddSemaphore
      });
      return sendByteWriteSubmission(reply, submission, {
        path: parsed.path,
        contentType,
        sizeBytes: bytes.byteLength,
        payloadSha256: sha256Hex(bytes),
        publicBaseUrl: config.publicBaseUrl
      });
    });
  });

  app.get("/v1/files", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ByteReadQuerySchema.parse(request.query);
    const path = normalizeEfsPath(query.path).canonicalPath;
    const receipt = await receipts.getLatestByPath(path, query.attester);
    if (receipt === undefined || receipt.operation === "file.remove") {
      throw notFound("No readable file receipt found for path");
    }
    if (receipt.status !== "confirmed") {
      throw bytesUnavailable("Latest file receipt is not confirmed");
    }
    const mirror = receipt.efs.mirrors.find(
      (candidate) => candidate.transport === "ipfs" && candidate.uri.startsWith("ipfs://")
    );
    if (mirror === undefined) {
      throw bytesUnavailable("Latest file receipt does not declare a retrievable IPFS mirror");
    }

    const fetched = await readFromIpfs(config.ipfs, {
      uri: mirror.uri,
      maxBytes: MAX_INLINE_CONTENT_BYTES
    });
    const actualHash = sha256Hex(fetched.bytes);
    if (actualHash !== receipt.integrity.payload_sha256) {
      throw badGateway("integrity_mismatch", "Fetched bytes did not match the EFS payload hash");
    }

    return reply
      .type(fetched.contentType ?? "application/octet-stream")
      .header("content-length", String(fetched.bytes.byteLength))
      .header("etag", `"${receipt.integrity.payload_sha256}"`)
      .header("digest", digestHeader(receipt.integrity.payload_sha256))
      .header("x-efs-payload-sha256", receipt.integrity.payload_sha256)
      .header("x-efs-scribe-receipt-id", receipt.receipt_id)
      .header("x-efs-mirror-uri", mirror.uri)
      .send(fetched.bytes);
  });

  app.post("/v1/files/plan", async (request: FastifyRequest) => {
    const parsed = FileWriteRequestSchema.parse(request.body);
    const context = writerContext(request, parsed, apiKeys, config);
    const prepared = await prepareFileWriteRequest(parsed, config, {
      onlyHashIpfs: true,
      authenticatedSubject: context.auth.authenticated_subject,
      ipfsRateLimiter,
      ipfsAddSemaphore,
      validatePreparedRequest: async (candidate) => {
        await writer.planFile(candidate, context);
      }
    });
    const plan = await writer.planFile(prepared, context);

    return planResponse(plan, config);
  });

  app.post("/v1/files", async (request: FastifyRequest, _reply: FastifyReply) => {
    const parsed = FileWriteRequestSchema.parse(request.body);
    const context = writerContext(request, parsed, apiKeys, config);
    if (parsed.options.dry_run) {
      const prepared = await prepareFileWriteRequest(parsed, config, {
        onlyHashIpfs: true,
        authenticatedSubject: context.auth.authenticated_subject,
        ipfsRateLimiter,
        ipfsAddSemaphore,
        validatePreparedRequest: async (candidate) => {
          await writer.planFile(candidate, context);
        }
      });
      const plan = await writer.planFile(prepared, context);
      return planResponse(plan, config);
    }

    const submission = await writeWithOptionalIdempotency({
      parsed,
      config,
      receipts,
      pendingIdempotentSubmissions,
      writer,
      context,
      writeRateLimiter,
      ipfsRateLimiter,
      ipfsAddSemaphore
    });
    return sendSubmission(_reply, submission);
  });

  app.post("/v1/files/delete", async (request: FastifyRequest, _reply: FastifyReply) => {
    const parsed = FileRemoveRequestSchema.parse(request.body);
    const context = writerContext(request, parsed, apiKeys, config);
    requireFileDeleteCapability(context);
    const submission = await removeWithOptionalIdempotency({
      receipts,
      pendingIdempotentSubmissions,
      parsed,
      writer,
      context,
      writeRateLimiter
    });
    return sendSubmission(_reply, submission);
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
    const query = ResolveQuerySchema.parse(request.query);

    const path = normalizeEfsPath(query.path).canonicalPath;
    const receipt = await receipts.getLatestByPath(path, query.attester);
    if (receipt === undefined) {
      throw notFound("No receipt found for path");
    }

    return {
      path,
      attester: receipt.agent_lens.attester,
      receipt_id: receipt.receipt_id,
      operation: receipt.operation,
      payload_sha256: receipt.integrity.payload_sha256,
      mirrors: receipt.efs.mirrors,
      uids: receipt.efs.uids,
      links: receipt.links
    };
  });

  app.post("/v1/verify", async (request: FastifyRequest) => {
    const body = VerifyReceiptBodySchema.parse(request.body);
    const receipt = body.receipt;
    return writer.verifyReceipt(receipt);
  });
}

async function prepareFileWriteRequest(
  parsed: FileWriteRequest,
  config: AppConfig,
  options: {
    onlyHashIpfs: boolean;
    authenticatedSubject: string;
    ipfsRateLimiter: TokenBucketRateLimiter;
    ipfsAddSemaphore: AsyncSemaphore;
    validatePreparedRequest?: (candidate: FileWriteRequest) => Promise<void>;
  }
): Promise<FileWriteRequest> {
  const storage = parsed.options.storage;
  if (parsed.content.mode !== "inline_base64") {
    if (storage === "ipfs") {
      throw badRequest("options.storage=ipfs requires inline_base64 content so EFS Scribe has bytes to pin");
    }
    return parsed;
  }

  const shouldPin =
    storage === "ipfs" || (storage === "auto" && config.ipfs.apiUrl !== undefined);
  if (!shouldPin) {
    return parsed;
  }
  if (config.ipfs.apiUrl === undefined) {
    throw new IpfsPinningError("IPFS pinning is not configured");
  }
  assertValidIpfsApiUrl(config.ipfs.apiUrl);

  const inlineContent = parsed.content;
  const bytes = Buffer.from(inlineContent.content_base64, "base64");
  const preparedContent = {
    mode: "external_mirror_only" as const,
    payload_sha256: sha256Hex(bytes),
    size_bytes: bytes.byteLength,
    content_type: inlineContent.content_type
  };
  const provisional = FileWriteRequestSchema.parse({
    ...parsed,
    content: preparedContent,
    mirrors: appendMirror(parsed.mirrors, { transport: "ipfs", uri: "ipfs://pending" })
  });
  await options.validatePreparedRequest?.(provisional);

  options.ipfsRateLimiter.consume(options.authenticatedSubject);
  const pinned = await options.ipfsAddSemaphore.run(() =>
    addToIpfs(config.ipfs, {
      bytes,
      contentType: inlineContent.content_type,
      filename: filenameFromPath(parsed.path),
      onlyHash: options.onlyHashIpfs
    })
  );

  return FileWriteRequestSchema.parse({
    ...parsed,
    content: preparedContent,
    mirrors: appendMirror(parsed.mirrors, { transport: "ipfs", uri: pinned.uri })
  });
}

function rawBytesWriteRequest(input: {
  bytes: Buffer;
  contentType: string;
  idempotencyKey?: string;
  path: string;
  claimedNandaId?: string;
  storage: StorageStrategy;
}): FileWriteRequest {
  if (input.bytes.byteLength === 0) {
    throw badRequest("Byte write body must not be empty");
  }
  if (input.bytes.byteLength > MAX_INLINE_CONTENT_BYTES) {
    throw payloadTooLarge(`Byte write body must be ${MAX_INLINE_CONTENT_BYTES} bytes or less`);
  }
  return FileWriteRequestSchema.parse({
    path: input.path,
    content: {
      mode: "inline_base64",
      content_base64: input.bytes.toString("base64"),
      content_type: input.contentType
    },
    mirrors: [],
    properties: { name: filenameFromPath(input.path) },
    agent: input.claimedNandaId === undefined ? {} : { claimed_nanda_id: input.claimedNandaId },
    options: {
      idempotency_key: input.idempotencyKey,
      storage: input.storage
    }
  });
}

function requestBodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  throw badRequest("Byte write body must be raw bytes");
}

function requestContentType(request: FastifyRequest): string {
  const value = singleHeader(request.headers["content-type"]) ?? "application/octet-stream";
  if (value.length > 128) {
    throw badRequest("content-type header must be 128 characters or less");
  }
  return value;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseStorageHeader(value: string | undefined): StorageStrategy {
  if (value === undefined) {
    return "ipfs";
  }
  const parsed = ByteStorageHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest("x-efs-storage must be auto, ipfs, or metadata_only");
  }
  return parsed.data;
}

function digestHeader(payloadSha256: `sha256:${string}`): string {
  return `sha-256=${Buffer.from(payloadSha256.slice("sha256:".length), "hex").toString("base64")}`;
}

function appendMirror(
  mirrors: FileWriteRequest["mirrors"],
  mirror: FileWriteRequest["mirrors"][number]
): FileWriteRequest["mirrors"] {
  if (mirrors.some((existing) => existing.transport === mirror.transport && existing.uri === mirror.uri)) {
    return mirrors;
  }
  return [...mirrors, mirror];
}

function filenameFromPath(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1);
  return segment === undefined || segment.length === 0 ? "file" : segment;
}

function isAuthenticatedWriteRoute(method: string, url: string): boolean {
  const path = url.split("?")[0];
  if (method === "PUT") {
    return path === "/v1/files";
  }
  if (method === "POST") {
    return path === "/v1/files" || path === "/v1/files/plan" || path === "/v1/files/delete";
  }
  return false;
}

class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly config: {
      capacity: number;
      refillTokens: number;
      refillIntervalMs: number;
    },
    private readonly errorMessage: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  consume(key: string): void {
    const bucket = this.refilledBucket(key);
    if (bucket.tokens < 1) {
      throw rateLimited(this.errorMessage);
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
  }

  private refilledBucket(key: string): { tokens: number; updatedAt: number } {
    const currentTime = this.now();
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      return { tokens: this.config.capacity, updatedAt: currentTime };
    }

    const elapsed = Math.max(0, currentTime - existing.updatedAt);
    const refillIntervals = Math.floor(elapsed / this.config.refillIntervalMs);
    if (refillIntervals === 0) {
      return existing;
    }

    return {
      tokens: Math.min(
        this.config.capacity,
        existing.tokens + refillIntervals * this.config.refillTokens
      ),
      updatedAt: existing.updatedAt + refillIntervals * this.config.refillIntervalMs
    };
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxActive: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    }
  }
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
  parsed: FileWriteRequest | FileRemoveRequest,
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

function requireFileDeleteCapability(context: WriterContext): void {
  if (context.auth.capabilities?.delete_files !== true) {
    throw forbidden("API key is not allowed to delete EFS files");
  }
}

async function writeWithOptionalIdempotency(input: {
  receipts: InMemoryReceiptRepository;
  pendingIdempotentSubmissions: Map<string, PendingIdempotentSubmission>;
  parsed: FileWriteRequest;
  config: AppConfig;
  writer: EfsWriter;
  context: WriterContext;
  writeRateLimiter: TokenBucketRateLimiter;
  ipfsRateLimiter: TokenBucketRateLimiter;
  ipfsAddSemaphore: AsyncSemaphore;
}): Promise<SubmissionResult> {
  const idempotencyKey = input.parsed.options.idempotency_key;
  const originalRequestHash = originalWriteRequestHash(input.parsed, input.context);
  if (idempotencyKey === undefined) {
    return prepareAndSubmit(input);
  }

  const key = idempotencyKeyFor(input.context.auth.authenticated_subject, idempotencyKey);
  const existing = await input.receipts.getIdempotencyEntry(
    input.context.auth.authenticated_subject,
    idempotencyKey
  );
  if (existing !== undefined) {
    assertSameOriginalIdempotentRequest(existing.requestHash, originalRequestHash);
    return { receipt: existing.receipt };
  }

  const pending = input.pendingIdempotentSubmissions.get(key);
  if (pending !== undefined) {
    if (pending.originalRequestHash !== originalRequestHash) {
      throw conflict("Idempotency key is already in use for a different file write request");
    }
    return pending.result;
  }

  const result = prepareAndSubmit(input);
  input.pendingIdempotentSubmissions.set(key, {
    originalRequestHash,
    result
  });
  try {
    return await result;
  } finally {
    input.pendingIdempotentSubmissions.delete(key);
  }
}

async function removeWithOptionalIdempotency(input: {
  receipts: InMemoryReceiptRepository;
  pendingIdempotentSubmissions: Map<string, PendingIdempotentSubmission>;
  parsed: FileRemoveRequest;
  writer: EfsWriter;
  context: WriterContext;
  writeRateLimiter: TokenBucketRateLimiter;
}): Promise<SubmissionResult> {
  const idempotencyKey = input.parsed.options.idempotency_key;
  const originalRequestHash = originalRemoveRequestHash(input.parsed, input.context);
  if (idempotencyKey === undefined) {
    input.writeRateLimiter.consume(input.context.auth.authenticated_subject);
    return removeAndStore(input);
  }

  const key = idempotencyKeyFor(input.context.auth.authenticated_subject, idempotencyKey);
  const existing = await input.receipts.getIdempotencyEntry(
    input.context.auth.authenticated_subject,
    idempotencyKey
  );
  if (existing !== undefined) {
    assertSameOriginalIdempotentRequest(existing.requestHash, originalRequestHash);
    return { receipt: existing.receipt };
  }

  const pending = input.pendingIdempotentSubmissions.get(key);
  if (pending !== undefined) {
    if (pending.originalRequestHash !== originalRequestHash) {
      throw conflict("Idempotency key is already in use for a different request");
    }
    return pending.result;
  }

  input.writeRateLimiter.consume(input.context.auth.authenticated_subject);
  const result = removeAndStore(input);
  input.pendingIdempotentSubmissions.set(key, {
    originalRequestHash,
    result
  });
  try {
    return await result;
  } finally {
    input.pendingIdempotentSubmissions.delete(key);
  }
}

async function removeAndStore(input: {
  receipts: InMemoryReceiptRepository;
  parsed: FileRemoveRequest;
  writer: EfsWriter;
  context: WriterContext;
}): Promise<SubmissionResult> {
  try {
    const receipt = await input.writer.removeFile(input.parsed, input.context);
    await input.receipts.save(receipt, {
      authenticatedSubject: input.context.auth.authenticated_subject,
      idempotencyKey: input.parsed.options.idempotency_key,
      idempotencyRequestHash: originalRemoveRequestHash(input.parsed, input.context)
    });
    return { receipt };
  } catch (error) {
    if (error instanceof SepoliaSubmitError && error.partialReceipt !== undefined) {
      await input.receipts.save(error.partialReceipt, {
        authenticatedSubject: input.context.auth.authenticated_subject,
        idempotencyKey: input.parsed.options.idempotency_key,
        idempotencyRequestHash: originalRemoveRequestHash(input.parsed, input.context)
      });
      return { receipt: error.partialReceipt, error };
    }
    throw error;
  }
}

async function prepareAndSubmit(input: {
  receipts: InMemoryReceiptRepository;
  parsed: FileWriteRequest;
  config: AppConfig;
  writer: EfsWriter;
  context: WriterContext;
  ipfsRateLimiter: TokenBucketRateLimiter;
  ipfsAddSemaphore: AsyncSemaphore;
  writeRateLimiter: TokenBucketRateLimiter;
}): Promise<SubmissionResult> {
  const prepared = await prepareFileWriteRequest(input.parsed, input.config, {
    onlyHashIpfs: false,
    authenticatedSubject: input.context.auth.authenticated_subject,
    ipfsRateLimiter: input.ipfsRateLimiter,
    ipfsAddSemaphore: input.ipfsAddSemaphore,
    validatePreparedRequest: async (candidate) => {
      await input.writer.planFile(candidate, input.context);
    }
  });
  input.writeRateLimiter.consume(input.context.auth.authenticated_subject);
  const plan = await input.writer.planFile(prepared, input.context);
  return submitAndStore({
    receipts: input.receipts,
    writer: input.writer,
    plan,
    context: input.context,
    idempotencyKey: input.parsed.options.idempotency_key,
    idempotencyRequestHash: originalWriteRequestHash(input.parsed, input.context)
  });
}

async function submitAndStore(input: {
  receipts: InMemoryReceiptRepository;
  writer: EfsWriter;
  plan: EfsWritePlan;
  context: WriterContext;
  idempotencyKey?: string;
  idempotencyRequestHash?: string;
}): Promise<SubmissionResult> {
  try {
    const receipt = await input.writer.submitPlan(input.plan, input.context);
    await input.receipts.save(receipt, {
      authenticatedSubject: input.context.auth.authenticated_subject,
      idempotencyKey: input.idempotencyKey,
      idempotencyRequestHash: input.idempotencyRequestHash
    });
    return { receipt };
  } catch (error) {
    if (error instanceof SepoliaSubmitError && error.partialReceipt !== undefined) {
      await input.receipts.save(error.partialReceipt, {
        authenticatedSubject: input.context.auth.authenticated_subject,
        idempotencyKey: input.idempotencyKey,
        idempotencyRequestHash: input.idempotencyRequestHash
      });
      return { receipt: error.partialReceipt, error };
    }
    throw error;
  }
}

function sendSubmission(reply: FastifyReply, submission: SubmissionResult) {
  if (submission.error !== undefined || submission.receipt.status === "failed") {
    return reply.status(503).send({
      ...sepoliaErrorBody(submission.error ?? new SepoliaSubmitError("Sepolia write failed")),
      receipt: submission.receipt,
      links: submission.receipt.links
    });
  }
  return {
    receipt: submission.receipt,
    links: submission.receipt.links
  };
}

function sendByteWriteSubmission(
  reply: FastifyReply,
  submission: SubmissionResult,
  input: {
    path: string;
    contentType: string;
    sizeBytes: number;
    payloadSha256: `sha256:${string}`;
    publicBaseUrl: string;
  }
) {
  if (submission.error !== undefined || submission.receipt.status === "failed") {
    return sendSubmission(reply, submission);
  }
  const receipt = submission.receipt;
  return {
    ok: true,
    path: input.path,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    payload_sha256: input.payloadSha256,
    receipt_id: receipt.receipt_id,
    receipt,
    links: {
      read: `${input.publicBaseUrl}/v1/files?path=${encodeURIComponent(input.path)}`,
      resolve: `${input.publicBaseUrl}/v1/resolve?path=${encodeURIComponent(input.path)}`,
      receipt: `${input.publicBaseUrl}/v1/receipts/${encodeURIComponent(receipt.receipt_id)}`,
      verify: `${input.publicBaseUrl}/v1/verify`
    }
  };
}

function sepoliaErrorBody(error: SepoliaPreflightError | SepoliaSubmitError) {
  return {
    error: "sepolia_write_error",
    message: error.message,
    ...(error instanceof SepoliaSubmitError && error.partialReceipt !== undefined
      ? { receipt: error.partialReceipt, links: error.partialReceipt.links }
      : {})
  };
}

function originalWriteRequestHash(parsed: FileWriteRequest, context: WriterContext): string {
  return sha256Hex({
    authenticatedSubject: context.auth.authenticated_subject,
    request: parsed
  });
}

function originalRemoveRequestHash(parsed: FileRemoveRequest, context: WriterContext): string {
  return sha256Hex({
    authenticatedSubject: context.auth.authenticated_subject,
    operation: "file.remove",
    request: parsed
  });
}

function assertSameOriginalIdempotentRequest(
  storedRequestHash: string | undefined,
  originalRequestHash: string
): void {
  if (storedRequestHash !== undefined && storedRequestHash !== originalRequestHash) {
    throw conflict("Idempotency key was already used for a different request");
  }
}

function idempotencyKeyFor(authenticatedSubject: string, idempotencyKey: string): string {
  return `${authenticatedSubject}\0${idempotencyKey}`;
}
