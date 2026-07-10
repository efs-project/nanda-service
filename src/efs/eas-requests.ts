import { decodeEventLog, parseAbiItem, parseEventLogs, type Log } from "viem";

import { encodePlannedAttestationData } from "./schema-encoding.js";
import type { EfsWritePlan, Hex, PlannedAttestation, Uid } from "./writer.js";

export const EAS_ATTESTED_EVENT =
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)" as const;

export const EAS_MULTIATTEST_ABI = [
  {
    type: "function",
    name: "multiAttest",
    stateMutability: "payable",
    inputs: [
      {
        name: "multiRequests",
        type: "tuple[]",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" }
            ]
          }
        ]
      }
    ],
    outputs: [{ name: "", type: "bytes32[]" }]
  },
  {
    type: "function",
    name: "multiRevoke",
    stateMutability: "payable",
    inputs: [
      {
        name: "multiRequests",
        type: "tuple[]",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple[]",
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" }
            ]
          }
        ]
      }
    ],
    outputs: []
  },
  parseAbiItem(EAS_ATTESTED_EVENT)
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface EasAttestationRequestData {
  recipient: Hex;
  expirationTime: bigint;
  revocable: boolean;
  refUID: Uid;
  data: Hex;
  value: bigint;
}

export interface EasMultiAttestationRequest {
  schema: Uid;
  data: EasAttestationRequestData[];
}

export interface EasRevocationRequestData {
  uid: Uid;
  value: bigint;
}

export interface EasMultiRevocationRequest {
  schema: Uid;
  data: EasRevocationRequestData[];
}

export interface EasLayerRequests {
  layer: number;
  requests: EasMultiAttestationRequest[];
  flatRefs: string[];
  flatSchemas: Uid[];
}

export interface EasAttestedEvent {
  attester: Hex;
  recipient: Hex;
  schemaUID: Uid;
  uid: Uid;
}

export function buildMultiAttestLayer(
  plan: EfsWritePlan,
  layer: number,
  refs: ReadonlyMap<string, Uid>,
  options: { skipRefs?: ReadonlySet<string> } = {}
): EasLayerRequests {
  const attestations = plan.layers.filter(
    (attestation) => attestation.layer === layer && !options.skipRefs?.has(attestation.ref)
  );
  const order: Uid[] = [];
  const bySchema = new Map<Uid, { refs: string[]; data: EasAttestationRequestData[] }>();

  for (const attestation of attestations) {
    const bucket = getSchemaBucket(bySchema, order, attestation.schema);
    bucket.refs.push(attestation.ref);
    bucket.data.push(materializeAttestation(attestation, refs));
  }

  return {
    layer,
    requests: order.map((schema) => ({ schema, data: bySchema.get(schema)?.data ?? [] })),
    flatRefs: order.flatMap((schema) => bySchema.get(schema)?.refs ?? []),
    flatSchemas: order.flatMap((schema) =>
      Array.from({ length: bySchema.get(schema)?.refs.length ?? 0 }, () => schema)
    )
  };
}

export function extractAttestedUidsFromLogs(
  logs: readonly Log[],
  easAddress: Hex,
  expected: number
): Uid[] {
  return extractAttestedEventsFromLogs(logs, easAddress, expected).map((event) => event.uid);
}

export function extractAttestedEventsFromLogs(
  logs: readonly Log[],
  easAddress: Hex,
  expected: number
): EasAttestedEvent[] {
  const easLower = easAddress.toLowerCase();
  const parsed = parseEventLogs({
    abi: EAS_MULTIATTEST_ABI,
    eventName: "Attested",
    logs: logs as Log[]
  });
  const events = parsed
    .filter((log) => log.address.toLowerCase() === easLower)
    .map((log) => log.args as unknown as EasAttestedEvent);

  if (events.length === expected) {
    return events;
  }

  const manual: EasAttestedEvent[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== easLower) {
      continue;
    }
    try {
      const event = decodeEventLog({
        abi: EAS_MULTIATTEST_ABI,
        data: log.data,
        topics: log.topics
      });
      if (event.eventName === "Attested") {
        manual.push(event.args as unknown as EasAttestedEvent);
      }
    } catch {
      /* Ignore non-EAS Attested logs. */
    }
  }

  if (manual.length !== expected) {
    throw new Error(`Expected ${expected} EAS Attested event(s), found ${events.length}`);
  }
  return manual;
}

export function assertAttestedEventsMatch(input: {
  events: readonly EasAttestedEvent[];
  expectedAttester: Hex;
  expectedSchemas: readonly Uid[];
}): void {
  if (input.events.length !== input.expectedSchemas.length) {
    throw new Error(
      `Expected ${input.expectedSchemas.length} EAS Attested event(s), found ${input.events.length}`
    );
  }
  const expectedAttester = input.expectedAttester.toLowerCase();
  input.events.forEach((event, index) => {
    if (event.attester.toLowerCase() !== expectedAttester) {
      throw new Error(`Unexpected EAS attester for event ${index}`);
    }
    const expectedSchema = input.expectedSchemas[index];
    if (expectedSchema !== undefined && event.schemaUID.toLowerCase() !== expectedSchema.toLowerCase()) {
      throw new Error(`Unexpected EAS schema for event ${index}`);
    }
  });
}

function getSchemaBucket(
  bySchema: Map<Uid, { refs: string[]; data: EasAttestationRequestData[] }>,
  order: Uid[],
  schema: Uid
): { refs: string[]; data: EasAttestationRequestData[] } {
  const existing = bySchema.get(schema);
  if (existing !== undefined) {
    return existing;
  }
  const created = { refs: [], data: [] };
  bySchema.set(schema, created);
  order.push(schema);
  return created;
}

function materializeAttestation(
  attestation: PlannedAttestation,
  refs: ReadonlyMap<string, Uid>
): EasAttestationRequestData {
  return {
    recipient: attestation.recipient ?? ZERO_ADDRESS,
    expirationTime: 0n,
    revocable: attestation.revocable,
    refUID: resolveRef(attestation.refUID, refs, `${attestation.ref}.refUID`),
    data: encodePlannedAttestationData(attestation, new Map(refs)),
    value: 0n
  };
}

function resolveRef(ref: PlannedAttestation["refUID"], refs: ReadonlyMap<string, Uid>, label: string): Uid {
  if (typeof ref === "string") {
    return ref;
  }
  const key = "external" in ref ? ref.external : ref.ref;
  const uid = refs.get(key);
  if (uid === undefined) {
    throw new Error(`Unresolved EFS ref ${key} while materializing ${label}`);
  }
  return uid;
}
