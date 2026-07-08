import { EFS_SCHEMA_UIDS } from "../config/chains.js";
import { canonicalJson, sha256Hex, toMockUid } from "../lib/hash.js";
import { ReceiptSchema, type EfsScribeReceipt, type VerificationCheck } from "../receipts/schema.js";
import type {
  EfsWriter,
  EfsWritePlan,
  FileWriteRequest,
  FileWriteRequestInput,
  Hex,
  PlannedAttestation,
  Uid,
  VerificationResult,
  WriterContext
} from "./writer.js";
import { FileWriteRequestSchema } from "./writer.js";

interface OfflineWriterOptions {
  now?: () => Date;
}

export class OfflineEfsWriter implements EfsWriter {
  readonly mode = "offline" as const;
  private readonly now: () => Date;

  constructor(options: OfflineWriterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async planFile(input: FileWriteRequestInput, context: WriterContext): Promise<EfsWritePlan> {
    const parsedInput = FileWriteRequestSchema.parse(input);
    const payloadHash = payloadSha256(parsedInput);
    const metadataHash = sha256Hex({
      path: parsedInput.path,
      mirrors: parsedInput.mirrors,
      properties: parsedInput.properties,
      agent: parsedInput.agent
    });
    const canonicalRequestHash = sha256Hex({
      operation: "file.upsert",
      auth: context.auth.authenticated_subject,
      path: parsedInput.path,
      payloadHash,
      metadataHash,
      idempotencyKey: parsedInput.options.idempotency_key ?? null
    });

    const layers: PlannedAttestation[] = [
      {
        ref: "data",
        layer: 0,
        schema: EFS_SCHEMA_UIDS.DATA,
        data: "0x",
        revocable: false,
        refUID: zeroUid()
      },
      {
        ref: "contentHash.property",
        layer: 0,
        schema: EFS_SCHEMA_UIDS.PROPERTY,
        data: dataHex(payloadHash),
        revocable: false,
        refUID: zeroUid()
      },
      {
        ref: "file.anchor",
        layer: 0,
        schema: EFS_SCHEMA_UIDS.ANCHOR,
        data: dataHex(parsedInput.path),
        revocable: false,
        refUID: zeroUid()
      },
      {
        ref: "placement.pin",
        layer: 1,
        schema: EFS_SCHEMA_UIDS.PIN,
        data: dataHex("definition:file-placement"),
        revocable: true,
        refUID: { ref: "file.anchor" }
      },
      {
        ref: "contentHash.pin",
        layer: 1,
        schema: EFS_SCHEMA_UIDS.PIN,
        data: dataHex("definition:contentHash"),
        revocable: true,
        refUID: { ref: "data" }
      },
      ...parsedInput.mirrors.map((mirror, index) => ({
        ref: `mirror.${index}`,
        layer: 1,
        schema: EFS_SCHEMA_UIDS.MIRROR,
        data: dataHex(canonicalJson(mirror)),
        revocable: true,
        refUID: { ref: "data" }
      }))
    ];

    return {
      operation: "file.upsert",
      canonicalRequestHash,
      attester: context.attester.address,
      path: parsedInput.path,
      layers
    };
  }

  async submitPlan(plan: EfsWritePlan, context: WriterContext): Promise<EfsScribeReceipt> {
    const minted = new Map<string, Uid>();
    for (const attestation of [...plan.layers].sort((a, b) => a.layer - b.layer)) {
      const material = {
        attester: context.attester.address,
        canonicalRequestHash: plan.canonicalRequestHash,
        data: attestation.data,
        layer: attestation.layer,
        ref: attestation.ref,
        refUID: resolveRef(attestation.refUID, minted),
        revocable: attestation.revocable,
        schema: attestation.schema
      };
      minted.set(attestation.ref, toMockUid("offline-eas-uid", material));
    }

    const dataUid = mustGet(minted, "data");
    const fileAnchorUid = mustGet(minted, "file.anchor");
    const placementPinUid = mustGet(minted, "placement.pin");
    const contentHashPinUid = mustGet(minted, "contentHash.pin");
    const mirrorUids = [...minted.entries()]
      .filter(([ref]) => ref.startsWith("mirror."))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, uid]) => uid);
    const checkedAt = this.now().toISOString();
    const receiptId = `rcpt_${plan.canonicalRequestHash.slice("sha256:".length, "sha256:".length + 24)}`;

    return ReceiptSchema.parse({
      receipt_version: "efs-scribe-receipt/v1",
      receipt_id: receiptId,
      status: "confirmed",
      mode: "offline",
      operation: "file.upsert",
      created_at: checkedAt,
      auth: context.auth,
      agent_lens: {
        attester: context.attester.address,
        derivation: context.attester.derivation
      },
      integrity: {
        payload_sha256: extractPayloadHash(plan),
        metadata_sha256: sha256Hex({
          path: plan.path,
          attester: context.attester.address,
          layers: plan.layers.map((layer) => layer.ref)
        }),
        canonical_request_sha256: plan.canonicalRequestHash
      },
      efs: {
        network: "offline",
        chain_id: 0,
        eas: null,
        tx_hashes: [],
        block_numbers: [],
        path: plan.path,
        uids: {
          data: dataUid,
          file_anchor: fileAnchorUid,
          placement_pin: placementPinUid,
          mirrors: mirrorUids,
          properties: {
            contentHash: contentHashPinUid
          }
        }
      },
      verification: {
        checked_at: checkedAt,
        checks: offlineChecks({ dataUid, fileAnchorUid, placementPinUid })
      },
      links: {
        self: `${context.publicBaseUrl}/v1/receipts/${receiptId}`,
        verify: `${context.publicBaseUrl}/v1/verify`,
        resolve: `${context.publicBaseUrl}/v1/resolve?path=${encodeURIComponent(plan.path)}`
      }
    });
  }

  async writeFile(input: FileWriteRequestInput, context: WriterContext): Promise<EfsScribeReceipt> {
    const plan = await this.planFile(input, context);
    return this.submitPlan(plan, context);
  }

  async verifyReceipt(receipt: EfsScribeReceipt): Promise<VerificationResult> {
    const parsed = ReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      return {
        ok: false,
        checks: [{ name: "receipt_schema", ok: false, detail: parsed.error.message }]
      };
    }

    const checks = offlineChecks({
      dataUid: parsed.data.efs.uids.data,
      fileAnchorUid: parsed.data.efs.uids.file_anchor,
      placementPinUid: parsed.data.efs.uids.placement_pin
    });
    return { ok: checks.every((check) => check.ok), checks };
  }
}

function payloadSha256(input: FileWriteRequest): `sha256:${string}` {
  if (input.content.mode === "inline_base64") {
    return sha256Hex(Buffer.from(input.content.content_base64, "base64"));
  }
  return input.content.payload_sha256 as `sha256:${string}`;
}

function extractPayloadHash(plan: EfsWritePlan): `sha256:${string}` {
  const property = plan.layers.find((layer) => layer.ref === "contentHash.property");
  if (property === undefined) {
    return sha256Hex("missing-content-hash-property");
  }
  return Buffer.from(property.data.slice(2), "hex").toString("utf8") as `sha256:${string}`;
}

function resolveRef(ref: PlannedAttestation["refUID"], minted: Map<string, Uid>): Uid {
  if (typeof ref === "string") {
    return ref;
  }
  return mustGet(minted, ref.ref);
}

function mustGet(minted: Map<string, Uid>, ref: string): Uid {
  const uid = minted.get(ref);
  if (uid === undefined) {
    throw new Error(`Missing planned attestation ref ${ref}`);
  }
  return uid;
}

function zeroUid(): Uid {
  return `0x${"0".repeat(64)}`;
}

function dataHex(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function offlineChecks(input: {
  dataUid: Uid;
  fileAnchorUid: Uid;
  placementPinUid: Uid;
}): VerificationCheck[] {
  return [
    { name: "offline_receipt_shape", ok: true },
    { name: "offline_data_uid", ok: /^0x[0-9a-f]{64}$/.test(input.dataUid) },
    { name: "offline_file_anchor_uid", ok: /^0x[0-9a-f]{64}$/.test(input.fileAnchorUid) },
    { name: "offline_placement_pin_uid", ok: /^0x[0-9a-f]{64}$/.test(input.placementPinUid) }
  ];
}
