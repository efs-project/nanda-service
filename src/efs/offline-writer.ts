import { toMockUid } from "../lib/hash.js";
import { ReceiptSchema, type EfsScribeReceipt, type VerificationCheck } from "../receipts/schema.js";
import { encodePlannedAttestationData } from "./schema-encoding.js";
import type {
  EfsWriter,
  EfsWritePlan,
  FileWriteRequestInput,
  PlannedAttestation,
  Uid,
  VerificationResult,
  WriterContext
} from "./writer.js";
import { buildFileWritePlan, collectPlannedMirrors } from "./write-plan.js";

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
    return buildFileWritePlan(input, context);
  }

  async submitPlan(plan: EfsWritePlan, context: WriterContext): Promise<EfsScribeReceipt> {
    const minted = new Map<string, Uid>();
    for (const requirement of plan.preflight) {
      minted.set(requirement.ref, toMockUid("offline-efs-external-ref", requirement.ref));
    }

    for (const attestation of [...plan.layers].sort((a, b) => a.layer - b.layer)) {
      const material = {
        attester: context.attester.address,
        canonicalRequestHash: plan.canonicalRequestHash,
        data: encodePlannedAttestationData(attestation, minted),
        definition: resolveOptionalRef(attestation.fields?.definition, minted),
        fields: attestation.fields,
        layer: attestation.layer,
        ref: attestation.ref,
        refUID: resolveRef(attestation.refUID, minted),
        revocable: attestation.revocable,
        schema: attestation.schema
      };
      minted.set(attestation.ref, toMockUid("offline-eas-uid", material));
    }

    const dataUid = mustGet(minted, "data");
    const fileAnchorUid = mustGet(minted, `anchor:${plan.path}`);
    const placementPinUid = mustGet(minted, "placement.pin");
    const propertyUids = collectPropertyPins(minted);
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
        payload_sha256: plan.payloadHash,
        metadata_sha256: plan.metadataHash,
        canonical_request_sha256: plan.canonicalRequestHash
      },
      efs: {
        network: "offline",
        chain_id: 0,
        eas: null,
        tx_hashes: [],
        block_numbers: [],
        path: plan.path,
        mirrors: collectPlannedMirrors(plan),
        uids: {
          data: dataUid,
          file_anchor: fileAnchorUid,
          placement_pin: placementPinUid,
          mirrors: mirrorUids,
          properties: propertyUids
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

function resolveRef(ref: PlannedAttestation["refUID"], minted: Map<string, Uid>): Uid {
  if (typeof ref === "string") {
    return ref;
  }
  if ("external" in ref) {
    return mustGet(minted, ref.external);
  }
  return mustGet(minted, ref.ref);
}

function resolveOptionalRef(value: unknown, minted: Map<string, Uid>): Uid | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "ref" in value &&
    typeof value.ref === "string"
  ) {
    return mustGet(minted, value.ref);
  }
  if (typeof value === "string" && value.startsWith("0x")) {
    return value as Uid;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "external" in value &&
    typeof value.external === "string"
  ) {
    return mustGet(minted, value.external);
  }
  return undefined;
}

function mustGet(minted: Map<string, Uid>, ref: string): Uid {
  const uid = minted.get(ref);
  if (uid === undefined) {
    throw new Error(`Missing planned attestation ref ${ref}`);
  }
  return uid;
}

function collectPropertyPins(minted: Map<string, Uid>): Record<string, Uid> {
  const properties: Record<string, Uid> = {};
  for (const [ref, uid] of minted.entries()) {
    const match = /^property:(.*)\.pin$/.exec(ref);
    if (match?.[1] !== undefined) {
      properties[match[1]] = uid;
    }
  }
  return Object.fromEntries(
    Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, Uid>;
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
