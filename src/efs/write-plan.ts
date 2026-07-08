import { EFS_SCHEMA_UIDS } from "../config/chains.js";
import { sha256Hex } from "../lib/hash.js";
import {
  encodeAnchorData,
  encodeMirrorData,
  encodePinData,
  encodePropertyData
} from "./schema-encoding.js";
import type {
  EfsWritePlan,
  FileWriteRequest,
  FileWriteRequestInput,
  PlannedAttestation,
  PreflightRequirement,
  Uid,
  WriterContext
} from "./writer.js";
import { FileWriteRequestSchema } from "./writer.js";

const ZERO_UID = `0x${"0".repeat(64)}` as const;
const RESERVED_ASCII = new Set(
  [..." \"#&/:=?@[\\]^`{|}%"].map((char) => char.charCodeAt(0))
);

export interface NormalizedAnchor {
  path: string;
  name: string;
  forSchema: Uid;
}

export interface NormalizedEfsPath {
  canonicalPath: string;
  segments: string[];
  anchors: NormalizedAnchor[];
}

export class EfsWritePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EfsWritePlanError";
  }
}

export function normalizeEfsPath(path: string): NormalizedEfsPath {
  if (!path.startsWith("/")) {
    throw new EfsWritePlanError("EFS path must be absolute");
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new EfsWritePlanError("EFS path must not have a trailing slash");
  }

  const segments = path.slice(1).split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new EfsWritePlanError("EFS path must not contain empty segments");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new EfsWritePlanError("EFS path must not contain relative segments");
  }

  const anchors = segments.map((segment, index) => {
    const anchorPath = `/${segments.slice(0, index + 1).join("/")}`;
    return {
      path: anchorPath,
      name: encodeAnchorName(segment),
      forSchema: index === segments.length - 1 ? EFS_SCHEMA_UIDS.DATA : ZERO_UID
    };
  });

  return {
    canonicalPath: `/${segments.join("/")}`,
    segments,
    anchors
  };
}

export function buildFileWritePlan(
  input: FileWriteRequestInput,
  context: WriterContext
): EfsWritePlan {
  const parsed = FileWriteRequestSchema.parse(input);
  const normalizedPath = normalizeEfsPath(parsed.path);
  const payloadHash = payloadSha256(parsed);
  const properties = normalizedProperties(parsed, payloadHash);
  const metadataHash = sha256Hex({
    agent: parsed.agent,
    mirrors: parsed.mirrors,
    path: normalizedPath.canonicalPath,
    properties
  });
  const canonicalRequestHash = sha256Hex({
    auth: context.auth.authenticated_subject,
    idempotencyKey: parsed.options.idempotency_key ?? null,
    metadataHash,
    operation: "file.upsert",
    path: normalizedPath.canonicalPath,
    payloadHash
  });

  return {
    operation: "file.upsert",
    canonicalRequestHash,
    payloadHash,
    metadataHash,
    attester: context.attester.address,
    path: normalizedPath.canonicalPath,
    preflight: preflightRequirements(normalizedPath, parsed),
    layers: [
      dataAttestation(),
      ...anchorAttestations(normalizedPath),
      ...propertyAttestations(properties),
      ...mirrorAttestations(parsed),
      placementPin(normalizedPath)
    ].sort((left, right) => left.layer - right.layer || left.ref.localeCompare(right.ref))
  };
}

function anchorAttestations(path: NormalizedEfsPath): PlannedAttestation[] {
  return path.anchors.map((anchor, index) => {
    const fields = {
      name: anchor.name,
      forSchema: anchor.forSchema
    };
    return {
      ref: `anchor:${anchor.path}`,
      layer: index,
      schema: EFS_SCHEMA_UIDS.ANCHOR,
      data: encodeAnchorData(anchor.name, anchor.forSchema),
      revocable: false,
      refUID:
        index === 0
          ? { external: "efs.rootAnchorUID" }
          : { ref: `anchor:/${path.segments.slice(0, index).join("/")}` },
      fields
    };
  });
}

function dataAttestation(): PlannedAttestation {
  return {
    ref: "data",
    layer: 0,
    schema: EFS_SCHEMA_UIDS.DATA,
    data: "0x",
    revocable: false,
    refUID: ZERO_UID,
    fields: {}
  };
}

function propertyAttestations(properties: Record<string, string>): PlannedAttestation[] {
  const attestations: PlannedAttestation[] = [];
  for (const [key, value] of Object.entries(properties).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const valueRef = `property:${key}.value`;
    const anchorRef = `property:${key}.anchor`;
    const pinRef = `property:${key}.pin`;
    const valueFields = { value };
    const anchorFields = {
      name: encodeAnchorName(key),
      forSchema: EFS_SCHEMA_UIDS.PROPERTY
    };
    const pinFields = {
      definition: { ref: anchorRef }
    };

    attestations.push(
      {
        ref: valueRef,
        layer: 0,
        schema: EFS_SCHEMA_UIDS.PROPERTY,
        data: encodePropertyData(value),
        revocable: false,
        refUID: ZERO_UID,
        fields: valueFields
      },
      {
        ref: anchorRef,
        layer: 1,
        schema: EFS_SCHEMA_UIDS.ANCHOR,
        data: encodeAnchorData(anchorFields.name, anchorFields.forSchema),
        revocable: false,
        refUID: { ref: "data" },
        fields: anchorFields
      },
      {
        ref: pinRef,
        layer: 2,
        schema: EFS_SCHEMA_UIDS.PIN,
        data: encodePinData(ZERO_UID),
        revocable: true,
        refUID: { ref: valueRef },
        fields: pinFields
      }
    );
  }
  return attestations;
}

function mirrorAttestations(input: FileWriteRequest): PlannedAttestation[] {
  return input.mirrors.map((mirror, index) => {
    const fields = {
      transport: mirror.transport,
      transportDefinition: { external: transportExternalRef(mirror.transport) },
      uri: mirror.uri
    };
    return {
      ref: `mirror.${index}`,
      layer: 1,
      schema: EFS_SCHEMA_UIDS.MIRROR,
      data: encodeMirrorData(ZERO_UID, mirror.uri),
      revocable: true,
      refUID: { ref: "data" },
      fields
    };
  });
}

function placementPin(path: NormalizedEfsPath): PlannedAttestation {
  const fileAnchor = path.anchors[path.anchors.length - 1];
  if (fileAnchor === undefined) {
    throw new Error("EFS file path must include a file anchor");
  }
  const fields = {
    definition: { ref: `anchor:${fileAnchor.path}` }
  };
  return {
    ref: "placement.pin",
    layer: path.anchors.length,
    schema: EFS_SCHEMA_UIDS.PIN,
    data: encodePinData(ZERO_UID),
    revocable: true,
    refUID: { ref: "data" },
    fields
  };
}

function normalizedProperties(
  input: FileWriteRequest,
  payloadHash: `sha256:${string}`
): Record<string, string> {
  const derivedSize = derivedSizeBytes(input);
  assertReservedProperties(input, payloadHash, derivedSize);

  const properties: Record<string, string> = { ...input.properties, contentHash: payloadHash };
  const contentType = input.content.content_type;
  if (contentType !== undefined && properties.contentType === undefined) {
    properties.contentType = contentType;
  }
  if (derivedSize !== undefined && properties.size === undefined) {
    properties.size = String(derivedSize);
  }
  return properties;
}

function assertReservedProperties(
  input: FileWriteRequest,
  payloadHash: `sha256:${string}`,
  derivedSize: number | undefined
): void {
  if (input.properties.contentHash !== undefined && input.properties.contentHash !== payloadHash) {
    throw new EfsWritePlanError("properties.contentHash is reserved and must match the payload hash");
  }
  if (
    input.properties.contentType !== undefined &&
    input.content.content_type !== undefined &&
    input.properties.contentType !== input.content.content_type
  ) {
    throw new EfsWritePlanError("properties.contentType must match content.content_type");
  }
  if (
    input.properties.size !== undefined &&
    derivedSize !== undefined &&
    input.properties.size !== String(derivedSize)
  ) {
    throw new EfsWritePlanError("properties.size must match the content size");
  }
}

function derivedSizeBytes(input: FileWriteRequest): number | undefined {
  if (input.content.mode === "inline_base64") {
    return Buffer.from(input.content.content_base64, "base64").byteLength;
  }
  if (input.content.mode === "hash_only") {
    return input.content.size_bytes;
  }
  return undefined;
}

function payloadSha256(input: FileWriteRequest): `sha256:${string}` {
  if (input.content.mode === "inline_base64") {
    return sha256Hex(Buffer.from(input.content.content_base64, "base64"));
  }
  return input.content.payload_sha256 as `sha256:${string}`;
}

function preflightRequirements(
  path: NormalizedEfsPath,
  input: FileWriteRequest
): PreflightRequirement[] {
  const requirements: PreflightRequirement[] = [
    {
      kind: "root_anchor",
      ref: "efs.rootAnchorUID",
      network: "sepolia",
      path: "/",
      description: "Read EFSIndexer.rootAnchorUID() and use it as the parent for top-level anchors."
    },
    ...path.anchors.map((anchor) => ({
      kind: "path_anchor" as const,
      ref: `efs.path.${anchor.path}`,
      network: "sepolia" as const,
      path: anchor.path,
      description:
        "Resolve this path before submitting. Reuse the existing anchor UID when present; attest it only when missing."
    }))
  ];

  const seenTransports = new Set<string>();
  for (const mirror of input.mirrors) {
    if (seenTransports.has(mirror.transport)) {
      continue;
    }
    seenTransports.add(mirror.transport);
    requirements.push({
      kind: "transport_anchor",
      ref: transportExternalRef(mirror.transport),
      network: "sepolia",
      path: `/transports/${mirror.transport}`,
      transport: mirror.transport,
      description: "Resolve this shared /transports child before submitting MIRROR attestations."
    });
  }

  return requirements;
}

function transportExternalRef(transport: string): string {
  return `efs.transport.${transport}`;
}

function encodeAnchorName(segment: string): string {
  const normalized = segment.normalize("NFC");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new EfsWritePlanError("Invalid EFS anchor segment");
  }

  let out = "";
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    if (isReservedAscii(code)) {
      out += percentByte(code);
    } else {
      out += char;
    }
  }
  return out;
}

function isReservedAscii(code: number): boolean {
  return code <= 0x1f || code === 0x7f || RESERVED_ASCII.has(code);
}

function percentByte(code: number): string {
  return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
}
