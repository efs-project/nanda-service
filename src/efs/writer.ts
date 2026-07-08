import { z } from "zod";

import type { DerivedAttester } from "../auth/derived-attester.js";
import type { AuthContext } from "../auth/subject.js";
import { EFS_TRANSPORTS } from "../config/chains.js";
import type { EfsScribeReceipt, VerificationCheck } from "../receipts/schema.js";

export type WriterMode = "offline" | "sepolia";
export type Hex = `0x${string}`;
export type Uid = Hex;
export type RefOrUid = Uid | { ref: string } | { external: string };

export const MAX_INLINE_CONTENT_BYTES = 4_096;
const MAX_BASE64_CHARS = Math.ceil(MAX_INLINE_CONTENT_BYTES / 3) * 4;
const MAX_PATH_CHARS = 512;
const MAX_MIRRORS = 8;
const MAX_PROPERTIES = 32;
const MAX_PROPERTY_KEY_CHARS = 96;
const MAX_PROPERTY_VALUE_CHARS = 1024;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

const MirrorSchema = z.object({
  transport: z.enum(EFS_TRANSPORTS),
  uri: z.string().min(1).max(2048)
});

const InlineContentSchema = z.object({
  mode: z.literal("inline_base64"),
  content_base64: z
    .string()
    .min(1)
    .max(MAX_BASE64_CHARS)
    .refine(isStrictBase64, {
      message: "content_base64 must be valid standard base64"
    })
    .refine((value) => Buffer.from(value, "base64").byteLength <= MAX_INLINE_CONTENT_BYTES, {
      message: `inline_base64 content must decode to ${MAX_INLINE_CONTENT_BYTES} bytes or less`
    }),
  content_type: z.string().min(1).max(128)
});

const HashOnlyContentSchema = z.object({
  mode: z.literal("hash_only"),
  payload_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative().optional(),
  content_type: z.string().min(1).max(128).optional()
});

const ExternalMirrorOnlyContentSchema = z.object({
  mode: z.literal("external_mirror_only"),
  payload_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content_type: z.string().min(1).max(128).optional()
});

export const FileWriteRequestSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_CHARS).startsWith("/"),
  content: z.discriminatedUnion("mode", [
    InlineContentSchema,
    HashOnlyContentSchema,
    ExternalMirrorOnlyContentSchema
  ]),
  mirrors: z.array(MirrorSchema).max(MAX_MIRRORS).default([]),
  properties: z.record(z.string().max(MAX_PROPERTY_VALUE_CHARS)).default({}),
  agent: z
    .object({
      claimed_nanda_id: z.string().min(1).max(256).optional(),
      label: z.string().min(1).max(128).optional()
    })
    .default({}),
  options: z
    .object({
      dry_run: z.boolean().default(false),
      idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARS).optional()
    })
    .default({})
}).superRefine((request, ctx) => {
  const entries = Object.entries(request.properties);
  if (entries.length > MAX_PROPERTIES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["properties"],
      message: `properties may contain at most ${MAX_PROPERTIES} entries`
    });
  }
  for (const [key] of entries) {
    if (key.length === 0 || key.length > MAX_PROPERTY_KEY_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["properties", key],
        message: `property keys must be 1-${MAX_PROPERTY_KEY_CHARS} characters`
      });
    }
  }
});

export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;
export type FileWriteRequestInput = z.input<typeof FileWriteRequestSchema>;

export interface WriterContext {
  auth: AuthContext;
  attester: DerivedAttester;
  publicBaseUrl: string;
}

export interface PlannedAttestation {
  ref: string;
  layer: number;
  schema: Uid;
  data: Hex;
  revocable: boolean;
  refUID: RefOrUid;
  recipient?: Hex;
  fields?: Record<string, unknown>;
}

export interface PreflightRequirement {
  kind: "root_anchor" | "path_anchor" | "transport_anchor";
  ref: string;
  description: string;
  network: "sepolia";
  path?: string;
  transport?: string;
  resolvedUid?: Uid;
}

export interface EfsWritePlan {
  operation: "file.upsert";
  canonicalRequestHash: `sha256:${string}`;
  payloadHash: `sha256:${string}`;
  metadataHash: `sha256:${string}`;
  attester: Hex;
  path: string;
  preflight: PreflightRequirement[];
  layers: PlannedAttestation[];
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

export interface EfsWriter {
  mode: WriterMode;
  planFile(input: FileWriteRequestInput, context: WriterContext): Promise<EfsWritePlan>;
  submitPlan(plan: EfsWritePlan, context: WriterContext): Promise<EfsScribeReceipt>;
  writeFile(input: FileWriteRequestInput, context: WriterContext): Promise<EfsScribeReceipt>;
  verifyReceipt(receipt: EfsScribeReceipt): Promise<VerificationResult>;
}

function isStrictBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
