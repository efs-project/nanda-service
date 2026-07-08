import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  parseAbiParameters,
  type Log
} from "viem";
import { describe, expect, it } from "vitest";

import { deriveAttester } from "../src/auth/derived-attester.js";
import type { AuthContext } from "../src/auth/subject.js";
import { EFS_SCHEMA_UIDS, EFS_SEPOLIA } from "../src/config/chains.js";
import {
  EAS_ATTESTED_EVENT,
  assertAttestedEventsMatch,
  buildMultiAttestLayer,
  extractAttestedEventsFromLogs,
  extractAttestedUidsFromLogs
} from "../src/efs/eas-requests.js";
import { buildFileWritePlan } from "../src/efs/write-plan.js";
import type { Uid } from "../src/efs/writer.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const auth: AuthContext = {
  method: "api_key",
  authenticated_subject: "api-key:local-scribe-agent",
  claimed_nanda_id: "agent:demo",
  auth_level: "write_key"
};

const context = {
  auth,
  attester: deriveAttester({
    subject: auth.authenticated_subject,
    secret: "unit-test-secret",
    chainId: 11155111
  }),
  publicBaseUrl: "http://localhost:3000"
};

describe("EAS request construction", () => {
  it("builds grouped multiAttest requests for one materialized layer", () => {
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
          content_type: "application/json"
        },
        mirrors: [{ transport: "https", uri: "https://example.com/status.json" }],
        properties: { name: "status.json" }
      },
      context
    );
    const dataUid = uid(10);
    const agentsUid = uid(11);
    const httpsTransportUid = uid(12);

    const layer = buildMultiAttestLayer(plan, 1, new Map<string, Uid>([
      ["data", dataUid],
      ["anchor:/agents", agentsUid],
      ["efs.transport.https", httpsTransportUid]
    ]));

    expect(layer.layer).toBe(1);
    expect(layer.flatRefs).toEqual([
      "anchor:/agents/demo",
      "property:contentHash.anchor",
      "property:contentType.anchor",
      "property:name.anchor",
      "mirror.0"
    ]);

    const mirrorRequest = layer.requests.find((request) => request.schema === EFS_SCHEMA_UIDS.MIRROR);
    expect(mirrorRequest?.data).toHaveLength(1);
    const mirrorData = mirrorRequest?.data[0];
    expect(mirrorData).toMatchObject({
      recipient: ZERO_ADDRESS,
      expirationTime: 0n,
      revocable: true,
      refUID: dataUid,
      value: 0n
    });
    expect(
      decodeAbiParameters(
        parseAbiParameters("bytes32 transportDefinition, string uri"),
        mirrorData?.data ?? "0x"
      )
    ).toEqual([httpsTransportUid, "https://example.com/status.json"]);
  });

  it("rejects layers whose symbolic refs are not materialized yet", () => {
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
        }
      },
      context
    );

    expect(() => buildMultiAttestLayer(plan, 1, new Map())).toThrow(/unresolved/i);
  });

  it("can omit already-resolved planned refs from a layer", () => {
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
          content_type: "application/json"
        }
      },
      context
    );

    const layer = buildMultiAttestLayer(
      plan,
      1,
      new Map<string, Uid>([
        ["data", uid(10)],
        ["anchor:/agents", uid(11)]
      ]),
      { skipRefs: new Set(["anchor:/agents/demo"]) }
    );

    expect(layer.flatRefs).toEqual([
      "property:contentHash.anchor",
      "property:contentType.anchor"
    ]);
    expect(layer.requests).toHaveLength(1);
    expect(layer.requests[0]?.schema).toBe(EFS_SCHEMA_UIDS.ANCHOR);
  });

  it("extracts EAS Attested UIDs in receipt order and filters non-EAS logs", () => {
    const first = uid(1);
    const ignored = uid(2);
    const second = uid(3);
    const logs = [
      attestedLog(EFS_SEPOLIA.eas, first),
      attestedLog("0x1111111111111111111111111111111111111111", ignored),
      attestedLog(EFS_SEPOLIA.eas, second)
    ];

    expect(extractAttestedUidsFromLogs(logs, EFS_SEPOLIA.eas, 2)).toEqual([first, second]);
    expect(() => extractAttestedUidsFromLogs(logs, EFS_SEPOLIA.eas, 3)).toThrow(/expected 3/i);
  });

  it("validates emitted attesters and schemas before mapping UIDs to planned refs", () => {
    const expectedAttester = "0x2222222222222222222222222222222222222222" as const;
    const logs = [
      attestedLog(EFS_SEPOLIA.eas, uid(1), {
        attester: expectedAttester,
        schemaUID: EFS_SCHEMA_UIDS.DATA
      }),
      attestedLog(EFS_SEPOLIA.eas, uid(2), {
        attester: expectedAttester,
        schemaUID: EFS_SCHEMA_UIDS.ANCHOR
      })
    ];
    const events = extractAttestedEventsFromLogs(logs, EFS_SEPOLIA.eas, 2);

    expect(() =>
      assertAttestedEventsMatch({
        events,
        expectedAttester,
        expectedSchemas: [EFS_SCHEMA_UIDS.DATA, EFS_SCHEMA_UIDS.ANCHOR]
      })
    ).not.toThrow();
    expect(() =>
      assertAttestedEventsMatch({
        events,
        expectedAttester: ZERO_ADDRESS,
        expectedSchemas: [EFS_SCHEMA_UIDS.DATA, EFS_SCHEMA_UIDS.ANCHOR]
      })
    ).toThrow(/attester/i);
    expect(() =>
      assertAttestedEventsMatch({
        events,
        expectedAttester,
        expectedSchemas: [EFS_SCHEMA_UIDS.ANCHOR, EFS_SCHEMA_UIDS.DATA]
      })
    ).toThrow(/schema/i);
  });
});

function uid(n: number): Uid {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function attestedLog(
  address: `0x${string}`,
  uidValue: Uid,
  options: { attester?: `0x${string}`; schemaUID?: Uid } = {}
): Log {
  const topics = encodeEventTopics({
    abi: [parseAbiItem(EAS_ATTESTED_EVENT)],
    eventName: "Attested",
    args: {
      recipient: ZERO_ADDRESS,
      attester: options.attester ?? ZERO_ADDRESS,
      schemaUID: options.schemaUID ?? EFS_SCHEMA_UIDS.DATA
    }
  });

  return {
    address,
    data: encodeAbiParameters(parseAbiParameters("bytes32 uid"), [uidValue]),
    topics,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false
  } as Log;
}
