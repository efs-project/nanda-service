import { describe, expect, it } from "vitest";

import { deriveAttester } from "../src/auth/derived-attester.js";
import type { AuthContext } from "../src/auth/subject.js";
import { EFS_SCHEMA_UIDS } from "../src/config/chains.js";
import { buildFileWritePlan } from "../src/efs/write-plan.js";
import { resolveSepoliaPreflight } from "../src/efs/sepolia-preflight.js";
import type { Uid } from "../src/efs/writer.js";

const ZERO_UID = `0x${"0".repeat(64)}` as const;

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

describe("resolveSepoliaPreflight", () => {
  it("resolves root, existing path anchors, missing path anchors, and transports", async () => {
    const root = uid(1);
    const agents = uid(2);
    const demo = uid(3);
    const transports = uid(4);
    const https = uid(5);
    const client = new FakeReadClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID,
      [pathKey(root, "transports")]: transports,
      [pathKey(transports, "https")]: https
    });
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
          content_type: "application/json"
        },
        mirrors: [{ transport: "https", uri: "https://example.com/status.json" }]
      },
      context
    );

    const result = await resolveSepoliaPreflight(plan, { publicClient: client });

    expect(result.resolvedRefs.get("efs.rootAnchorUID")).toBe(root);
    expect(result.resolvedRefs.get("efs.transport.https")).toBe(https);
    expect(result.pathAnchors).toEqual([
      expect.objectContaining({ path: "/agents", exists: true, uid: agents, parentUid: root }),
      expect.objectContaining({ path: "/agents/demo", exists: true, uid: demo, parentUid: agents }),
      expect.objectContaining({
        path: "/agents/demo/status.json",
        exists: false,
        uid: undefined,
        parentUid: demo,
        plannedRef: "anchor:/agents/demo/status.json"
      })
    ]);
    expect(result.missingPathAnchors.map((anchor) => anchor.path)).toEqual([
      "/agents/demo/status.json"
    ]);
    expect(result.activeVisibilityTagRefs).toEqual([]);
    expect(client.resolveAnchorCalls).toContainEqual({
      parent: demo,
      name: "status.json",
      forSchema: EFS_SCHEMA_UIDS.DATA
    });
  });

  it("uses canonical EFS anchor names for path reads", async () => {
    const root = uid(1);
    const agents = uid(2);
    const demo = uid(3);
    const client = new FakeReadClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "Q%26A%3A%20Episode%205.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
    });
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/Q&A: Episode 5.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
        }
      },
      context
    );

    await resolveSepoliaPreflight(plan, { publicClient: client });

    expect(client.resolveAnchorCalls).toContainEqual({
      parent: demo,
      name: "Q%26A%3A%20Episode%205.json",
      forSchema: EFS_SCHEMA_UIDS.DATA
    });
  });

  it("detects already-active folder visibility tags", async () => {
    const root = uid(11);
    const agents = uid(12);
    const demo = uid(13);
    const client = new FakeReadClient(
      root,
      {
        [pathKey(root, "agents")]: agents,
        [pathKey(agents, "demo")]: demo,
        [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
      },
      {
        [tagKey(agents, EFS_SCHEMA_UIDS.DATA, context.attester.address)]: true
      }
    );
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

    const result = await resolveSepoliaPreflight(plan, { publicClient: client });

    expect(result.activeVisibilityTagRefs).toEqual(["visibility.tag:/agents"]);
    expect(client.activeTagCalls).toEqual([
      { target: agents, definition: EFS_SCHEMA_UIDS.DATA, attesters: [context.attester.address] },
      { target: demo, definition: EFS_SCHEMA_UIDS.DATA, attesters: [context.attester.address] }
    ]);
  });

  it("detects an active file placement for the authenticated agent lens", async () => {
    const root = uid(14);
    const agents = uid(15);
    const demo = uid(16);
    const fileAnchor = uid(17);
    const placementPin = uid(18);
    const data = uid(19);
    const client = new FakeReadClient(
      root,
      {
        [pathKey(root, "agents")]: agents,
        [pathKey(agents, "demo")]: demo,
        [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
      },
      {},
      {
        [pinSlotKey(fileAnchor, context.attester.address, EFS_SCHEMA_UIDS.DATA)]: {
          pinUID: placementPin,
          targetID: data
        }
      }
    );
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

    const result = await resolveSepoliaPreflight(plan, { publicClient: client });

    expect(result.activePlacement).toEqual({
      path: "/agents/demo/status.json",
      fileAnchorUid: fileAnchor,
      placementPinUid: placementPin,
      dataUid: data
    });
  });

  it("rejects a zero root anchor and missing transport anchors", async () => {
    await expect(
      resolveSepoliaPreflight(
        buildFileWritePlan(
          {
            path: "/agents/demo/status.json",
            content: {
              mode: "hash_only",
              payload_sha256:
                "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
            }
          },
          context
        ),
        { publicClient: new FakeReadClient(ZERO_UID, {}) }
      )
    ).rejects.toThrow(/rootAnchorUID/);

    await expect(
      resolveSepoliaPreflight(
        buildFileWritePlan(
          {
            path: "/agents/demo/status.json",
            content: {
              mode: "hash_only",
              payload_sha256:
                "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
            },
            mirrors: [{ transport: "ipfs", uri: "ipfs://example" }]
          },
          context
        ),
        {
          publicClient: new FakeReadClient(uid(1), {
            [pathKey(uid(1), "transports")]: uid(2),
            [pathKey(uid(2), "ipfs")]: ZERO_UID
          })
        }
      )
    ).rejects.toThrow(/transport.*ipfs/i);
  });
});

function uid(n: number): Uid {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

class FakeReadClient {
  readonly resolvePathCalls: { parent: Uid; name: string }[] = [];
  readonly resolveAnchorCalls: { parent: Uid; name: string; forSchema: Uid }[] = [];
  readonly activeTagCalls: { target: Uid; definition: Uid; attesters: readonly `0x${string}`[] }[] = [];

  constructor(
    private readonly root: Uid,
    private readonly paths: Record<string, Uid>,
    private readonly activeTags: Record<string, boolean> = {},
    private readonly pinSlots: Record<string, { pinUID: Uid; targetID: Uid }> = {}
  ) {}

  async readContract(args: { functionName: "rootAnchorUID"; args?: readonly unknown[] }): Promise<Uid>;
  async readContract(args: { functionName: "resolvePath"; args?: readonly unknown[] }): Promise<Uid>;
  async readContract(args: { functionName: "resolveAnchor"; args?: readonly unknown[] }): Promise<Uid>;
  async readContract(args: {
    functionName: "hasActiveTagFromAny";
    args?: readonly unknown[];
  }): Promise<boolean>;
  async readContract(args: {
    functionName: "getActivePinSlot";
    args?: readonly unknown[];
  }): Promise<{ pinUID: Uid; targetID: Uid }>;
  async readContract(args: {
    functionName:
      | "rootAnchorUID"
      | "resolvePath"
      | "resolveAnchor"
      | "hasActiveTagFromAny"
      | "getActivePinSlot";
    args?: readonly unknown[];
  }): Promise<Uid | boolean | { pinUID: Uid; targetID: Uid }> {
    if (args.functionName === "rootAnchorUID") {
      return this.root;
    }
    if (args.functionName === "getActivePinSlot") {
      const [definition, attester, targetSchema] = args.args ?? [];
      return (
        this.pinSlots[pinSlotKey(definition as Uid, attester as `0x${string}`, targetSchema as Uid)] ?? {
          pinUID: ZERO_UID,
          targetID: ZERO_UID
        }
      );
    }
    if (args.functionName === "hasActiveTagFromAny") {
      const [target, definition, attesters] = args.args ?? [];
      const normalizedAttesters = (attesters ?? []) as readonly `0x${string}`[];
      this.activeTagCalls.push({
        target: target as Uid,
        definition: definition as Uid,
        attesters: normalizedAttesters
      });
      return normalizedAttesters.some(
        (attester) => this.activeTags[tagKey(target as Uid, definition as Uid, attester)] === true
      );
    }
    if (args.functionName === "resolveAnchor") {
      const [parent, name, forSchema] = args.args ?? [];
      this.resolveAnchorCalls.push({
        parent: parent as Uid,
        name: String(name),
        forSchema: forSchema as Uid
      });
      return this.paths[anchorKey(parent as Uid, String(name), forSchema as Uid)] ?? ZERO_UID;
    }
    const [parent, name] = args.args ?? [];
    this.resolvePathCalls.push({ parent: parent as Uid, name: String(name) });
    return this.paths[pathKey(parent as Uid, String(name))] ?? ZERO_UID;
  }
}

function pathKey(parent: Uid, name: string): string {
  return `path:${parent}:${name}`;
}

function anchorKey(parent: Uid, name: string, forSchema: Uid): string {
  return `anchor:${parent}:${name}:${forSchema}`;
}

function tagKey(target: Uid, definition: Uid, attester: `0x${string}`): string {
  return `tag:${target}:${definition}:${attester.toLowerCase()}`;
}

function pinSlotKey(definition: Uid, attester: `0x${string}`, targetSchema: Uid): string {
  return `pin:${definition}:${attester.toLowerCase()}:${targetSchema}`;
}
