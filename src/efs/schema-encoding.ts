import { encodeAbiParameters, parseAbiParameters } from "viem";

import { EFS_SCHEMA_UIDS } from "../config/chains.js";
import type { Hex, PlannedAttestation, Uid } from "./writer.js";

const ZERO_UID = `0x${"0".repeat(64)}` as const;

interface EncodeOptions {
  allowUnresolvedPlaceholders?: boolean;
}

export function encodeAnchorData(name: string, forSchema: Uid): Hex {
  return encodeAbiParameters(parseAbiParameters("string name, bytes32 forSchema"), [
    name,
    forSchema
  ]);
}

export function encodePropertyData(value: string): Hex {
  return encodeAbiParameters(parseAbiParameters("string value"), [value]);
}

export function encodePinData(definition: Uid): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32 definition"), [definition]);
}

export function encodeMirrorData(transportDefinition: Uid, uri: string): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32 transportDefinition, string uri"), [
    transportDefinition,
    uri
  ]);
}

export function encodePlannedAttestationData(
  attestation: PlannedAttestation,
  refs: Map<string, Uid> = new Map(),
  options: EncodeOptions = {}
): Hex {
  if (attestation.schema === EFS_SCHEMA_UIDS.DATA) {
    return "0x";
  }
  if (attestation.schema === EFS_SCHEMA_UIDS.ANCHOR) {
    return encodeAnchorData(
      fieldString(attestation, "name"),
      fieldUid(attestation, "forSchema", refs, options)
    );
  }
  if (attestation.schema === EFS_SCHEMA_UIDS.PROPERTY) {
    return encodePropertyData(fieldString(attestation, "value"));
  }
  if (attestation.schema === EFS_SCHEMA_UIDS.PIN) {
    return encodePinData(fieldUid(attestation, "definition", refs, options));
  }
  if (attestation.schema === EFS_SCHEMA_UIDS.MIRROR) {
    return encodeMirrorData(
      fieldUid(attestation, "transportDefinition", refs, options),
      fieldString(attestation, "uri")
    );
  }
  return attestation.data;
}

function fieldString(attestation: PlannedAttestation, name: string): string {
  const value = attestation.fields?.[name];
  if (typeof value !== "string") {
    throw new Error(`${attestation.ref} missing string field ${name}`);
  }
  return value;
}

function fieldUid(
  attestation: PlannedAttestation,
  name: string,
  refs: Map<string, Uid>,
  options: EncodeOptions
): Uid {
  const value = attestation.fields?.[name];
  if (isRef(value)) {
    const resolved = refs.get(value.ref);
    if (resolved === undefined) {
      if (options.allowUnresolvedPlaceholders === true) {
        return ZERO_UID;
      }
      throw new Error(`Unresolved planned attestation ref ${value.ref} for ${attestation.ref}`);
    }
    return resolved;
  }
  if (isExternal(value)) {
    const resolved = refs.get(value.external);
    if (resolved === undefined) {
      if (options.allowUnresolvedPlaceholders === true) {
        return ZERO_UID;
      }
      throw new Error(`Unresolved external EFS ref ${value.external} for ${attestation.ref}`);
    }
    return resolved;
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
    return value as Uid;
  }
  throw new Error(`${attestation.ref} missing bytes32 field ${name}`);
}

function isRef(value: unknown): value is { ref: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "ref" in value &&
    typeof value.ref === "string"
  );
}

function isExternal(value: unknown): value is { external: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "external" in value &&
    typeof value.external === "string"
  );
}
