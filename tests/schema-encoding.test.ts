import { decodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { EFS_SCHEMA_UIDS } from "../src/config/chains.js";
import {
  encodeAnchorData,
  encodeMirrorData,
  encodePinData,
  encodePlannedAttestationData,
  encodePropertyData,
  encodeTagData
} from "../src/efs/schema-encoding.js";

describe("EFS schema encoding", () => {
  it("ABI-encodes anchor fields", () => {
    const encoded = encodeAnchorData("status.json", EFS_SCHEMA_UIDS.DATA);

    const [name, forSchema] = decodeAbiParameters(
      parseAbiParameters("string name, bytes32 forSchema"),
      encoded
    );

    expect(name).toBe("status.json");
    expect(forSchema).toBe(EFS_SCHEMA_UIDS.DATA);
  });

  it("ABI-encodes property, pin, and mirror fields", () => {
    const property = encodePropertyData("sha256:abc");
    const pin = encodePinData(EFS_SCHEMA_UIDS.DATA);
    const mirror = encodeMirrorData(EFS_SCHEMA_UIDS.MIRROR, "https://example.com/status.json");
    const tag = encodeTagData(EFS_SCHEMA_UIDS.DATA, 1n);

    expect(decodeAbiParameters(parseAbiParameters("string value"), property)[0]).toBe(
      "sha256:abc"
    );
    expect(decodeAbiParameters(parseAbiParameters("bytes32 definition"), pin)[0]).toBe(
      EFS_SCHEMA_UIDS.DATA
    );
    expect(
      decodeAbiParameters(
        parseAbiParameters("bytes32 transportDefinition, string uri"),
        mirror
      )
    ).toEqual([EFS_SCHEMA_UIDS.MIRROR, "https://example.com/status.json"]);
    expect(decodeAbiParameters(parseAbiParameters("bytes32 definition, int256 weight"), tag)).toEqual([
      EFS_SCHEMA_UIDS.DATA,
      1n
    ]);
  });

  it("requires symbolic refs to be resolved unless placeholders are explicit", () => {
    const symbolicPin = {
      ref: "property:contentHash.pin",
      layer: 2,
      schema: EFS_SCHEMA_UIDS.PIN,
      data: "0x",
      revocable: true,
      refUID: { ref: "property:contentHash.value" },
      fields: {
        definition: { ref: "property:contentHash.anchor" }
      }
    } as const;

    expect(() => encodePlannedAttestationData(symbolicPin)).toThrow(/Unresolved/);

    const encoded = encodePlannedAttestationData(symbolicPin, new Map(), {
      allowUnresolvedPlaceholders: true
    });

    expect(decodeAbiParameters(parseAbiParameters("bytes32 definition"), encoded)[0]).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  });
});
