import { z } from "zod";

import type { DerivedAttester } from "../auth/derived-attester.js";
import type { AuthContext } from "../auth/subject.js";
import type { EfsScribeReceipt, VerificationCheck } from "../receipts/schema.js";

export type WriterMode = "offline" | "sepolia";
export type Hex = `0x${string}`;
export type Uid = Hex;
export type RefOrUid = Uid | { ref: string } | { external: string };

const MirrorSchema = z.object({
  transport: z.string().min(1),
  uri: z.string().min(1).max(2048)
});

const InlineContentSchema = z.object({
  mode: z.literal("inline_base64"),
  content_base64: z.string().min(1),
  content_type: z.string().min(1)
});

const HashOnlyContentSchema = z.object({
  mode: z.literal("hash_only"),
  payload_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative().optional(),
  content_type: z.string().min(1).optional()
});

const ExternalMirrorOnlyContentSchema = z.object({
  mode: z.literal("external_mirror_only"),
  payload_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content_type: z.string().min(1).optional()
});

export const FileWriteRequestSchema = z.object({
  path: z.string().min(1).startsWith("/"),
  content: z.discriminatedUnion("mode", [
    InlineContentSchema,
    HashOnlyContentSchema,
    ExternalMirrorOnlyContentSchema
  ]),
  mirrors: z.array(MirrorSchema).default([]),
  properties: z.record(z.string()).default({}),
  agent: z
    .object({
      claimed_nanda_id: z.string().min(1).optional(),
      label: z.string().min(1).optional()
    })
    .default({}),
  options: z
    .object({
      dry_run: z.boolean().default(false),
      idempotency_key: z.string().min(1).optional()
    })
    .default({})
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
