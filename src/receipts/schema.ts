import { z } from "zod";

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AddressSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
);
const TxHashSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
);
const UidSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
);
const MirrorMetadataSchema = z.object({
  transport: z.string().min(1),
  uri: z.string().min(1)
});

export const VerificationCheckSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional()
});

export const ReceiptSchema = z.object({
  receipt_version: z.literal("efs-scribe-receipt/v1"),
  receipt_id: z.string().min(1),
  status: z.enum(["planned", "pending", "confirmed", "failed"]),
  mode: z.enum(["offline", "sepolia"]),
  operation: z.enum(["file.upsert", "file.remove"]),
  created_at: z.string().datetime(),
  auth: z.object({
    method: z.enum(["api_key", "signed_agent", "none"]),
    authenticated_subject: z.string().min(1),
    claimed_nanda_id: z.string().optional(),
    auth_level: z.enum(["write_key", "signed_request", "local_dev"])
  }),
  agent_lens: z.object({
    attester: AddressSchema,
    derivation: z.string().min(1)
  }),
  integrity: z.object({
    payload_sha256: HashSchema,
    metadata_sha256: HashSchema,
    canonical_request_sha256: HashSchema
  }),
  efs: z.object({
    network: z.enum(["offline", "sepolia"]),
    chain_id: z.number().int().nonnegative(),
    eas: AddressSchema.nullable(),
    tx_hashes: z.array(TxHashSchema),
    block_numbers: z.array(z.number().int().nonnegative()),
    path: z.string().min(1),
    mirrors: z.array(MirrorMetadataSchema).default([]),
    uids: z.object({
      data: UidSchema,
      file_anchor: UidSchema,
      placement_pin: UidSchema,
      mirrors: z.array(UidSchema),
      properties: z.record(UidSchema)
    })
  }),
  verification: z.object({
    checked_at: z.string().datetime(),
    checks: z.array(VerificationCheckSchema)
  }),
  links: z
    .object({
      self: z.string(),
      verify: z.string(),
      resolve: z.string()
    })
    .optional()
});

export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
export type EfsScribeReceipt = z.infer<typeof ReceiptSchema>;
