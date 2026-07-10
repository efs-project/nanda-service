import { EFS_SCHEMA_UIDS, EFS_SEPOLIA } from "../config/chains.js";
import type { EfsWritePlan, Hex, PlannedAttestation, PreflightRequirement, Uid } from "./writer.js";

const ZERO_UID = `0x${"0".repeat(64)}` as const;

export const EFS_INDEXER_ABI = [
  {
    type: "function",
    name: "rootAnchorUID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "resolvePath",
    stateMutability: "view",
    inputs: [
      { name: "parent", type: "bytes32" },
      { name: "name", type: "string" }
    ],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "resolveAnchor",
    stateMutability: "view",
    inputs: [
      { name: "parent", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "forSchema", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bytes32" }]
  }
] as const;

export const EFS_EDGE_RESOLVER_ABI = [
  {
    type: "function",
    name: "hasActiveTagFromAny",
    stateMutability: "view",
    inputs: [
      { name: "targetID", type: "bytes32" },
      { name: "definition", type: "bytes32" },
      { name: "attesters", type: "address[]" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "getActivePinSlot",
    stateMutability: "view",
    inputs: [
      { name: "definition", type: "bytes32" },
      { name: "attester", type: "address" },
      { name: "targetSchema", type: "bytes32" }
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "pinUID", type: "bytes32" },
          { name: "targetID", type: "bytes32" }
        ]
      }
    ]
  }
] as const;

export interface SepoliaReadClient {
  readContract(args: {
    address?: Hex;
    abi?: typeof EFS_INDEXER_ABI;
    functionName: "rootAnchorUID";
  }): Promise<Uid>;
  readContract(args: {
    address?: Hex;
    abi?: typeof EFS_INDEXER_ABI;
    functionName: "resolvePath";
    args: readonly [Uid, string];
  }): Promise<Uid>;
  readContract(args: {
    address?: Hex;
    abi?: typeof EFS_INDEXER_ABI;
    functionName: "resolveAnchor";
    args: readonly [Uid, string, Uid];
  }): Promise<Uid>;
  readContract(args: {
    address?: Hex;
    abi?: typeof EFS_EDGE_RESOLVER_ABI;
    functionName: "hasActiveTagFromAny";
    args: readonly [Uid, Uid, readonly Hex[]];
  }): Promise<boolean>;
  readContract(args: {
    address?: Hex;
    abi?: typeof EFS_EDGE_RESOLVER_ABI;
    functionName: "getActivePinSlot";
    args: readonly [Uid, Hex, Uid];
  }): Promise<{ pinUID: Uid; targetID: Uid }>;
}

export interface SepoliaPreflightOptions {
  publicClient: SepoliaReadClient;
  indexerAddress?: Hex;
  edgeResolverAddress?: Hex;
}

export interface PathAnchorPreflight {
  path: string;
  plannedRef: string;
  name: string;
  parentUid?: Uid;
  parentRef: string;
  uid?: Uid;
  exists: boolean;
  blockedByMissingParent?: string;
}

export interface TransportAnchorPreflight {
  transport: string;
  path: string;
  ref: string;
  uid: Uid;
}

export interface SepoliaPreflightResult {
  resolvedRefs: Map<string, Uid>;
  rootAnchorUid: Uid;
  transportsAnchorUid?: Uid;
  pathAnchors: PathAnchorPreflight[];
  missingPathAnchors: PathAnchorPreflight[];
  transportAnchors: TransportAnchorPreflight[];
  activeVisibilityTagRefs: string[];
}

export class SepoliaPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SepoliaPreflightError";
  }
}

export async function resolveSepoliaPreflight(
  plan: EfsWritePlan,
  options: SepoliaPreflightOptions
): Promise<SepoliaPreflightResult> {
  const indexerAddress = options.indexerAddress ?? EFS_SEPOLIA.indexer;
  const edgeResolverAddress = options.edgeResolverAddress ?? EFS_SEPOLIA.edgeResolver;
  const rootAnchorUid = await options.publicClient.readContract({
    address: indexerAddress,
    abi: EFS_INDEXER_ABI,
    functionName: "rootAnchorUID"
  });
  if (isZeroUid(rootAnchorUid)) {
    throw new SepoliaPreflightError("EFSIndexer.rootAnchorUID() returned zero");
  }

  const resolvedRefs = new Map<string, Uid>([["efs.rootAnchorUID", rootAnchorUid]]);
  const pathAnchors = await resolvePathAnchors(plan, options.publicClient, indexerAddress, rootAnchorUid);
  for (const anchor of pathAnchors) {
    if (anchor.uid !== undefined) {
      resolvedRefs.set(`efs.path.${anchor.path}`, anchor.uid);
    }
  }

  const transportAnchors = await resolveTransportAnchors(
    plan.preflight,
    options.publicClient,
    indexerAddress,
    rootAnchorUid,
    resolvedRefs
  );
  const activeVisibilityTagRefs = await resolveActiveVisibilityTags(
    plan,
    options.publicClient,
    edgeResolverAddress,
    pathAnchors
  );

  return {
    resolvedRefs,
    rootAnchorUid,
    transportsAnchorUid: transportAnchors.length === 0 ? undefined : resolvedRefs.get("efs.path./transports"),
    pathAnchors,
    missingPathAnchors: pathAnchors.filter((anchor) => !anchor.exists),
    transportAnchors,
    activeVisibilityTagRefs
  };
}

async function resolvePathAnchors(
  plan: EfsWritePlan,
  publicClient: SepoliaReadClient,
  indexerAddress: Hex,
  rootAnchorUid: Uid
): Promise<PathAnchorPreflight[]> {
  const anchorLayers = new Map(
    plan.layers
      .filter((layer) => layer.ref.startsWith("anchor:/"))
      .map((layer) => [layer.ref.slice("anchor:".length), layer])
  );
  const requirements = plan.preflight
    .filter((requirement) => requirement.kind === "path_anchor" && requirement.path !== undefined)
    .sort((left, right) => pathDepth(left.path ?? "") - pathDepth(right.path ?? ""));

  const results: PathAnchorPreflight[] = [];
  let parentUid: Uid | undefined = rootAnchorUid;
  let parentRef = "efs.rootAnchorUID";
  let blockedByMissingParent: string | undefined;

  for (const requirement of requirements) {
    const path = mustPath(requirement);
    const plannedRef = `anchor:${path}`;
    const layer = anchorLayers.get(path);
    if (layer === undefined) {
      throw new SepoliaPreflightError(`Missing planned path anchor layer for ${path}`);
    }
    const name = fieldString(layer, "name");
    const forSchema = fieldUid(layer, "forSchema");

    if (parentUid === undefined) {
      const blocked: PathAnchorPreflight = {
        path,
        plannedRef,
        name,
        parentRef,
        exists: false,
        blockedByMissingParent
      };
      results.push(blocked);
      blockedByMissingParent ??= path;
      parentRef = plannedRef;
      continue;
    }

    const uid: Uid = isZeroUid(forSchema)
      ? await publicClient.readContract({
          address: indexerAddress,
          abi: EFS_INDEXER_ABI,
          functionName: "resolvePath",
          args: [parentUid, name]
        })
      : await publicClient.readContract({
          address: indexerAddress,
          abi: EFS_INDEXER_ABI,
          functionName: "resolveAnchor",
          args: [parentUid, name, forSchema]
        });
    const exists: boolean = !isZeroUid(uid);
    const result: PathAnchorPreflight = {
      path,
      plannedRef,
      name,
      parentUid,
      parentRef,
      exists,
      uid: exists ? uid : undefined
    };
    results.push(result);

    parentUid = exists ? uid : undefined;
    parentRef = plannedRef;
    blockedByMissingParent = exists ? undefined : path;
  }

  return results;
}

async function resolveTransportAnchors(
  requirements: PreflightRequirement[],
  publicClient: SepoliaReadClient,
  indexerAddress: Hex,
  rootAnchorUid: Uid,
  resolvedRefs: Map<string, Uid>
): Promise<TransportAnchorPreflight[]> {
  const transports = uniqueTransports(requirements);
  if (transports.length === 0) {
    return [];
  }

  const transportsAnchorUid = await publicClient.readContract({
    address: indexerAddress,
    abi: EFS_INDEXER_ABI,
    functionName: "resolvePath",
    args: [rootAnchorUid, "transports"]
  });
  if (isZeroUid(transportsAnchorUid)) {
    throw new SepoliaPreflightError("Missing shared /transports anchor on Sepolia");
  }
  resolvedRefs.set("efs.path./transports", transportsAnchorUid);

  const resolved: TransportAnchorPreflight[] = [];
  for (const transport of transports) {
    const uid = await publicClient.readContract({
      address: indexerAddress,
      abi: EFS_INDEXER_ABI,
      functionName: "resolvePath",
      args: [transportsAnchorUid, transport]
    });
    if (isZeroUid(uid)) {
      throw new SepoliaPreflightError(`Missing shared /transports/${transport} transport anchor`);
    }
    const ref = `efs.transport.${transport}`;
    resolvedRefs.set(ref, uid);
    resolved.push({ transport, path: `/transports/${transport}`, ref, uid });
  }
  return resolved;
}

async function resolveActiveVisibilityTags(
  plan: EfsWritePlan,
  publicClient: SepoliaReadClient,
  edgeResolverAddress: Hex,
  pathAnchors: PathAnchorPreflight[]
): Promise<string[]> {
  const pathAnchorUids = new Map(
    pathAnchors
      .filter((anchor): anchor is PathAnchorPreflight & { uid: Uid } => anchor.uid !== undefined)
      .map((anchor) => [anchor.plannedRef, anchor.uid])
  );
  const active: string[] = [];

  for (const attestation of plan.layers) {
    if (attestation.schema !== EFS_SCHEMA_UIDS.TAG) {
      continue;
    }
    const targetRef = refKey(attestation.refUID);
    if (targetRef === undefined) {
      continue;
    }
    const targetUid = pathAnchorUids.get(targetRef);
    if (targetUid === undefined) {
      continue;
    }
    const definition = fieldUid(attestation, "definition");
    const alreadyActive = await publicClient.readContract({
      address: edgeResolverAddress,
      abi: EFS_EDGE_RESOLVER_ABI,
      functionName: "hasActiveTagFromAny",
      args: [targetUid, definition, [plan.attester]]
    });
    if (alreadyActive) {
      active.push(attestation.ref);
    }
  }

  return active;
}

function uniqueTransports(requirements: PreflightRequirement[]): string[] {
  return [
    ...new Set(
      requirements
        .filter((requirement) => requirement.kind === "transport_anchor")
        .map((requirement) => requirement.transport)
        .filter((transport): transport is string => transport !== undefined)
    )
  ].sort((left, right) => left.localeCompare(right));
}

function fieldString(attestation: PlannedAttestation, field: string): string {
  const value = attestation.fields?.[field];
  if (typeof value !== "string") {
    throw new SepoliaPreflightError(`${attestation.ref} missing string field ${field}`);
  }
  return value;
}

function fieldUid(attestation: PlannedAttestation, field: string): Uid {
  const value = attestation.fields?.[field];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new SepoliaPreflightError(`${attestation.ref} missing bytes32 field ${field}`);
  }
  return value as Uid;
}

function refKey(ref: PlannedAttestation["refUID"]): string | undefined {
  if (typeof ref === "object" && "ref" in ref) {
    return ref.ref;
  }
  return undefined;
}

function mustPath(requirement: PreflightRequirement): string {
  if (requirement.path === undefined) {
    throw new SepoliaPreflightError(`${requirement.ref} missing path`);
  }
  return requirement.path;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isZeroUid(uid: Uid): boolean {
  return uid.toLowerCase() === ZERO_UID;
}
