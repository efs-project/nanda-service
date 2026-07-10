import {
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
import { EAS_ATTESTED_EVENT } from "../src/efs/eas-requests.js";
import { SepoliaEfsWriter, SepoliaSubmitError } from "../src/efs/sepolia-writer.js";
import { EfsFileWriteConflictError, type Hex, type Uid } from "../src/efs/writer.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
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

describe("SepoliaEfsWriter", () => {
  it("funds the derived agent wallet, reuses existing anchors, writes missing layers, and returns a receipt", async () => {
    const root = uid(1);
    const agents = uid(2);
    const demo = uid(3);
    const transports = uid(4);
    const https = uid(5);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID,
      [pathKey(root, "transports")]: transports,
      [pathKey(transports, "https")]: https
    });
    const sponsorWallet = new FakeSepoliaWallet(publicClient);
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      sponsorWallet,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 1_000_000n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    const receipt = await writer.writeFile(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "inline_base64",
          content_base64: Buffer.from('{"ok":true}', "utf8").toString("base64"),
          content_type: "application/json"
        },
        mirrors: [{ transport: "https", uri: "https://example.com/status.json" }],
        properties: { name: "status.json" },
        agent: { claimed_nanda_id: "agent:demo" }
      },
      context
    );

    expect(sponsorWallet.sentTransfers).toMatchObject([
      { to: context.attester.address, value: 1_000_000n }
    ]);
    expect(agentWallet.contractWrites.every((write) => write.account?.address === context.attester.address)).toBe(
      true
    );
    expect(agentWallet.contractWrites.map((write) => attestationCount(write))).toEqual([
      5,
      5,
      5,
      1,
      2
    ]);
    expect(receipt).toMatchObject({
      status: "confirmed",
      mode: "sepolia",
      auth,
      agent_lens: {
        attester: context.attester.address,
        derivation: "efs-scribe/sepolia/v1"
      },
      efs: {
        network: "sepolia",
        chain_id: 11155111,
        eas: EFS_SEPOLIA.eas,
        path: "/agents/demo/status.json"
      }
    });
    expect(receipt.efs.tx_hashes).toHaveLength(5);
    expect(receipt.efs.block_numbers).toEqual([101, 102, 103, 104, 105]);
    expect(receipt.efs.uids.data).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.efs.uids.file_anchor).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.efs.uids.placement_pin).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.efs.uids.mirrors).toHaveLength(1);
    expect(receipt.efs.mirrors).toEqual([
      { transport: "https", uri: "https://example.com/status.json" }
    ]);
    expect(Object.keys(receipt.efs.uids.properties).sort()).toEqual([
      "contentHash",
      "contentType",
      "name",
      "size"
    ]);

    await expect(writer.verifyReceipt(receipt)).resolves.toMatchObject({ ok: true });
  });

  it("refunds the derived agent wallet between Sepolia write layers when gas drains it", async () => {
    const root = uid(61);
    const agents = uid(62);
    const demo = uid(63);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
    });
    const sponsorWallet = new FakeSepoliaWallet(publicClient);
    const agentWallet = new FakeSepoliaWallet(publicClient, 600_000n);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      sponsorWallet,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 1_000_000n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    const receipt = await writer.writeFile(
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

    expect(receipt.status).toBe("confirmed");
    expect(sponsorWallet.sentTransfers.length).toBeGreaterThan(1);
    expect(sponsorWallet.sentTransfers.every((transfer) => transfer.to === context.attester.address)).toBe(
      true
    );
  });

  it("can place a new DATA at an already-existing file anchor", async () => {
    const root = uid(11);
    const agents = uid(12);
    const demo = uid(13);
    const fileAnchor = uid(14);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
    });
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    const receipt = await writer.writeFile(
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

    expect(agentWallet.contractWrites.map((write) => attestationCount(write))).toEqual([
      2,
      1,
      1,
      1,
      2
    ]);
    expect(receipt.efs.uids.file_anchor).toBe(fileAnchor);
    expect(receipt.efs.uids.placement_pin).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects writes to an existing active file placement before sending transactions", async () => {
    const root = uid(51);
    const agents = uid(52);
    const demo = uid(53);
    const fileAnchor = uid(54);
    const placementPin = uid(55);
    const data = uid(56);
    const publicClient = new FakeSepoliaPublicClient(
      root,
      {
        [pathKey(root, "agents")]: agents,
        [pathKey(agents, "demo")]: demo,
        [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
      },
      {
        [pinSlotKey(fileAnchor, context.attester.address, EFS_SCHEMA_UIDS.DATA)]: {
          pinUID: placementPin,
          targetID: data
        }
      }
    );
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    await expect(
      writer.writeFile(
        {
          path: "/agents/demo/status.json",
          content: {
            mode: "hash_only",
            payload_sha256:
              "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
          }
        },
        context
      )
    ).rejects.toThrow(EfsFileWriteConflictError);
    expect(agentWallet.contractWrites).toHaveLength(0);
  });

  it("revokes the active file placement PIN when removing a file", async () => {
    const root = uid(15);
    const agents = uid(16);
    const demo = uid(17);
    const fileAnchor = uid(18);
    const placementPin = uid(19);
    const data = uid(20);
    const publicClient = new FakeSepoliaPublicClient(
      root,
      {
        [pathKey(root, "agents")]: agents,
        [pathKey(agents, "demo")]: demo,
        [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
      },
      {
        [pinSlotKey(fileAnchor, context.attester.address, EFS_SCHEMA_UIDS.DATA)]: {
          pinUID: placementPin,
          targetID: data
        }
      }
    );
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    const receipt = await writer.removeFile(
      {
        path: "/agents/demo/status.json",
        agent: { claimed_nanda_id: "agent:demo" },
        options: { idempotency_key: "remove-status-001" }
      },
      context
    );

    expect(agentWallet.contractWrites).toHaveLength(1);
    expect(agentWallet.contractWrites[0]).toMatchObject({
      functionName: "multiRevoke",
      account: { address: context.attester.address }
    });
    expect(agentWallet.contractWrites[0]?.args?.[0]).toEqual([
      {
        schema: EFS_SCHEMA_UIDS.PIN,
        data: [{ uid: placementPin, value: 0n }]
      }
    ]);
    expect(receipt).toMatchObject({
      status: "confirmed",
      mode: "sepolia",
      operation: "file.remove",
      efs: {
        path: "/agents/demo/status.json",
        uids: {
          data,
          file_anchor: fileAnchor,
          placement_pin: placementPin
        }
      }
    });
    expect(receipt.efs.tx_hashes).toHaveLength(1);
    expect(receipt.efs.block_numbers).toEqual([100]);
    await expect(writer.verifyReceipt(receipt)).resolves.toMatchObject({ ok: true });
  });

  it("rejects removal when no active file placement exists for the agent", async () => {
    const root = uid(24);
    const agents = uid(25);
    const demo = uid(26);
    const fileAnchor = uid(27);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
    });
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    await expect(
      writer.removeFile(
        {
          path: "/agents/demo/status.json",
          agent: { claimed_nanda_id: "agent:demo" }
        },
        context
      )
    ).rejects.toThrow(/No active EFS file placement/);
    expect(agentWallet.contractWrites).toHaveLength(0);
  });

  it("attaches a failed receipt when a removal transaction reverts after broadcast", async () => {
    const root = uid(28);
    const agents = uid(29);
    const demo = uid(30);
    const fileAnchor = uid(31);
    const placementPin = uid(32);
    const data = uid(33);
    const publicClient = new FakeSepoliaPublicClient(
      root,
      {
        [pathKey(root, "agents")]: agents,
        [pathKey(agents, "demo")]: demo,
        [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: fileAnchor
      },
      {
        [pinSlotKey(fileAnchor, context.attester.address, EFS_SCHEMA_UIDS.DATA)]: {
          pinUID: placementPin,
          targetID: data
        }
      },
      "reverted"
    );
    const agentWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    let partialReceipt: unknown;
    const remove = writer.removeFile(
      {
        path: "/agents/demo/status.json",
        agent: { claimed_nanda_id: "agent:demo" },
        options: { idempotency_key: "remove-status-reverted-001" }
      },
      context
    ).catch((error: unknown) => {
      partialReceipt = (error as { partialReceipt?: unknown }).partialReceipt;
      throw error;
    });

    await expect(remove).rejects.toMatchObject({
      partialReceipt: expect.objectContaining({
        status: "failed",
        operation: "file.remove",
        efs: expect.objectContaining({
          tx_hashes: [expect.stringMatching(/^0x[0-9a-f]{64}$/)],
          block_numbers: []
        })
      })
    });
    expect((partialReceipt as { verification: { checks: unknown[] } }).verification.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sepolia_remove_failed", ok: false })
      ])
    );
    await expect(writer.verifyReceipt(partialReceipt as never)).resolves.toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "sepolia_receipt_status", ok: false })
      ])
    });
  });

  it("classifies pre-send viem failures as Sepolia submit errors", async () => {
    const root = uid(21);
    const agents = uid(22);
    const demo = uid(23);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
    });
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => new FailingSepoliaWallet(),
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    await expect(
      writer.writeFile(
        {
          path: "/agents/demo/status.json",
          content: {
            mode: "hash_only",
            payload_sha256:
              "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
          }
        },
        context
      )
    ).rejects.toThrow(SepoliaSubmitError);
  });

  it("does not fund the derived agent when Sepolia preflight fails", async () => {
    const root = uid(31);
    const agents = uid(32);
    const demo = uid(33);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
    });
    const sponsorWallet = new FakeSepoliaWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      sponsorWallet,
      walletClientFactory: () => new FakeSepoliaWallet(publicClient),
      agentFundingTargetWei: 1_000_000n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    await expect(
      writer.writeFile(
        {
          path: "/agents/demo/status.json",
          content: {
            mode: "hash_only",
            payload_sha256:
              "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
          },
          mirrors: [{ transport: "https", uri: "https://example.com/status.json" }]
        },
        context
      )
    ).rejects.toThrow(/transport/i);
    expect(sponsorWallet.sentTransfers).toEqual([]);
  });

  it("attaches a failed receipt when a later Sepolia layer fails after earlier txs land", async () => {
    const root = uid(41);
    const agents = uid(42);
    const demo = uid(43);
    const publicClient = new FakeSepoliaPublicClient(root, {
      [pathKey(root, "agents")]: agents,
      [pathKey(agents, "demo")]: demo,
      [anchorKey(demo, "status.json", EFS_SCHEMA_UIDS.DATA)]: ZERO_UID
    });
    const agentWallet = new FailingAfterFirstWriteWallet(publicClient);
    const writer = new SepoliaEfsWriter({
      chainId: 11155111,
      easAddress: EFS_SEPOLIA.eas,
      indexerAddress: EFS_SEPOLIA.indexer,
      publicClient,
      walletClientFactory: () => agentWallet,
      agentFundingTargetWei: 0n,
      now: () => new Date("2026-07-08T00:00:00Z")
    });

    let partialReceipt: unknown;
    const write = writer.writeFile(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
        }
      },
      context
    ).catch((error: unknown) => {
      partialReceipt = (error as { partialReceipt?: unknown }).partialReceipt;
      throw error;
    });

    await expect(write).rejects.toMatchObject({
      partialReceipt: expect.objectContaining({
        status: "failed",
        efs: expect.objectContaining({
          tx_hashes: [expect.stringMatching(/^0x[0-9a-f]{64}$/)]
        })
      })
    });

    await expect(writer.verifyReceipt(partialReceipt as never)).resolves.toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "sepolia_receipt_status", ok: false })
      ])
    });
  });
});

function uid(n: number): Uid {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function pathKey(parent: Uid, name: string): string {
  return `path:${parent}:${name}`;
}

function anchorKey(parent: Uid, name: string, forSchema: Uid): string {
  return `anchor:${parent}:${name}:${forSchema}`;
}

function pinSlotKey(definition: Uid, attester: Hex, targetSchema: Uid): string {
  return `pin:${definition}:${attester.toLowerCase()}:${targetSchema}`;
}

function attestationCount(write: { args?: readonly unknown[] }): number {
  const requests = write.args?.[0] as { data: unknown[] }[] | undefined;
  return requests?.reduce((count, request) => count + request.data.length, 0) ?? 0;
}

class FakeSepoliaPublicClient {
  private readonly pendingReceipts = new Map<Hex, Uid[]>();
  private readonly balances = new Map<Hex, bigint>();
  private nextUid = 1000;
  private nextBlock = 100n;

  constructor(
    private readonly root: Uid,
    private readonly paths: Record<string, Uid>,
    private readonly pinSlots: Record<string, { pinUID: Uid; targetID: Uid }> = {},
    private readonly receiptStatus: "success" | "reverted" = "success"
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
        this.pinSlots[pinSlotKey(definition as Uid, attester as Hex, targetSchema as Uid)] ?? {
          pinUID: ZERO_UID,
          targetID: ZERO_UID
        }
      );
    }
    if (args.functionName === "hasActiveTagFromAny") {
      return false;
    }
    if (args.functionName === "resolveAnchor") {
      const [parent, name, forSchema] = args.args ?? [];
      return this.paths[anchorKey(parent as Uid, String(name), forSchema as Uid)] ?? ZERO_UID;
    }
    const [parent, name] = args.args ?? [];
    return this.paths[pathKey(parent as Uid, String(name))] ?? ZERO_UID;
  }

  async getBalance(args: { address: Hex }): Promise<bigint> {
    return this.balances.get(args.address) ?? 0n;
  }

  creditBalance(address: Hex, value: bigint): void {
    this.balances.set(address, (this.balances.get(address) ?? 0n) + value);
  }

  debitBalance(address: Hex, value: bigint): void {
    const balance = this.balances.get(address) ?? 0n;
    if (balance < value) {
      throw new Error("insufficient test balance");
    }
    this.balances.set(address, balance - value);
  }

  registerWrite(hash: Hex, schemas: Uid[]): void {
    this.pendingReceipts.set(hash, schemas);
  }

  async waitForTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    logs: Log[];
    blockNumber: bigint;
  }> {
    const schemas = this.pendingReceipts.get(args.hash) ?? [];
    const logs = schemas.map((schema) => attestedLog(EFS_SEPOLIA.eas, uid(this.nextUid++), schema));
    return {
      status: this.receiptStatus,
      logs,
      blockNumber: this.nextBlock++
    };
  }
}

class FakeSepoliaWallet {
  readonly sentTransfers: { to: Hex; value: bigint }[] = [];
  readonly contractWrites: {
    args?: readonly unknown[];
    account?: { address?: Hex };
    functionName?: "multiAttest" | "multiRevoke";
  }[] = [];
  private txCount = 1;

  constructor(
    private readonly publicClient: FakeSepoliaPublicClient,
    private readonly writeCostWei = 0n
  ) {}

  async sendTransaction(args: { to: Hex; value: bigint }): Promise<Hex> {
    this.sentTransfers.push(args);
    const hash = uid(9000 + this.txCount++);
    this.publicClient.creditBalance(args.to, args.value);
    this.publicClient.registerWrite(hash, []);
    return hash;
  }

  async writeContract(args: {
    args?: readonly unknown[];
    account?: { address?: Hex };
    functionName?: "multiAttest" | "multiRevoke";
  }): Promise<Hex> {
    this.contractWrites.push(args);
    if (this.writeCostWei > 0n && args.account?.address !== undefined) {
      this.publicClient.debitBalance(args.account.address, this.writeCostWei);
    }
    const hash = uid(10000 + this.txCount++);
    this.publicClient.registerWrite(hash, args.functionName === "multiRevoke" ? [] : attestationSchemas(args));
    return hash;
  }
}

class FailingSepoliaWallet {
  async writeContract(): Promise<Hex> {
    throw new Error("execution reverted");
  }
}

class FailingAfterFirstWriteWallet extends FakeSepoliaWallet {
  override async writeContract(args: {
    args?: readonly unknown[];
    account?: { address?: Hex };
    functionName?: "multiAttest" | "multiRevoke";
  }): Promise<Hex> {
    if (this.contractWrites.length > 0) {
      throw new Error("layer two reverted");
    }
    return super.writeContract(args);
  }
}

function attestationSchemas(write: { args?: readonly unknown[] }): Uid[] {
  const requests = write.args?.[0] as { schema: Uid; data: unknown[] }[] | undefined;
  return requests?.flatMap((request) =>
    Array.from({ length: request.data.length }, () => request.schema)
  ) ?? [];
}

function attestedLog(address: `0x${string}`, uidValue: Uid, schemaUID: Uid): Log {
  const topics = encodeEventTopics({
    abi: [parseAbiItem(EAS_ATTESTED_EVENT)],
    eventName: "Attested",
    args: {
      recipient: ZERO_ADDRESS,
      attester: context.attester.address,
      schemaUID
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
