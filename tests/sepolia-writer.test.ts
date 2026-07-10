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
import type { Hex, Uid } from "../src/efs/writer.js";

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
    expect(agentWallet.contractWrites.map((write) => attestationCount(write))).toEqual([5, 5, 5, 1]);
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
    expect(receipt.efs.tx_hashes).toHaveLength(4);
    expect(receipt.efs.block_numbers).toEqual([101, 102, 103, 104]);
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

    expect(agentWallet.contractWrites.map((write) => attestationCount(write))).toEqual([2, 1, 1, 1]);
    expect(receipt.efs.uids.file_anchor).toBe(fileAnchor);
    expect(receipt.efs.uids.placement_pin).toMatch(/^0x[0-9a-f]{64}$/);
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

function attestationCount(write: { args?: readonly unknown[] }): number {
  const requests = write.args?.[0] as { data: unknown[] }[] | undefined;
  return requests?.reduce((count, request) => count + request.data.length, 0) ?? 0;
}

class FakeSepoliaPublicClient {
  private readonly pendingReceipts = new Map<Hex, Uid[]>();
  private nextUid = 1000;
  private nextBlock = 100n;

  constructor(
    private readonly root: Uid,
    private readonly paths: Record<string, Uid>
  ) {}

  async readContract(args: {
    functionName: "rootAnchorUID" | "resolvePath" | "resolveAnchor";
    args?: readonly unknown[];
  }): Promise<Uid> {
    if (args.functionName === "rootAnchorUID") {
      return this.root;
    }
    if (args.functionName === "resolveAnchor") {
      const [parent, name, forSchema] = args.args ?? [];
      return this.paths[anchorKey(parent as Uid, String(name), forSchema as Uid)] ?? ZERO_UID;
    }
    const [parent, name] = args.args ?? [];
    return this.paths[pathKey(parent as Uid, String(name))] ?? ZERO_UID;
  }

  async getBalance(): Promise<bigint> {
    return 0n;
  }

  registerWrite(hash: Hex, schemas: Uid[]): void {
    this.pendingReceipts.set(hash, schemas);
  }

  async waitForTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success";
    logs: Log[];
    blockNumber: bigint;
  }> {
    const schemas = this.pendingReceipts.get(args.hash) ?? [];
    const logs = schemas.map((schema) => attestedLog(EFS_SEPOLIA.eas, uid(this.nextUid++), schema));
    return {
      status: "success",
      logs,
      blockNumber: this.nextBlock++
    };
  }
}

class FakeSepoliaWallet {
  readonly sentTransfers: { to: Hex; value: bigint }[] = [];
  readonly contractWrites: { args?: readonly unknown[]; account?: { address?: Hex } }[] = [];
  private txCount = 1;

  constructor(private readonly publicClient: FakeSepoliaPublicClient) {}

  async sendTransaction(args: { to: Hex; value: bigint }): Promise<Hex> {
    this.sentTransfers.push(args);
    const hash = uid(9000 + this.txCount++);
    this.publicClient.registerWrite(hash, []);
    return hash;
  }

  async writeContract(args: { args?: readonly unknown[]; account?: { address?: Hex } }): Promise<Hex> {
    this.contractWrites.push(args);
    const hash = uid(10000 + this.txCount++);
    this.publicClient.registerWrite(hash, attestationSchemas(args));
    return hash;
  }
}

class FailingSepoliaWallet {
  async writeContract(): Promise<Hex> {
    throw new Error("execution reverted");
  }
}

class FailingAfterFirstWriteWallet extends FakeSepoliaWallet {
  override async writeContract(args: { args?: readonly unknown[]; account?: { address?: Hex } }): Promise<Hex> {
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
