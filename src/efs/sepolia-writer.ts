import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Log
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { EFS_SEPOLIA } from "../config/chains.js";
import type { AppConfig } from "../config/env.js";
import { ReceiptSchema, type EfsScribeReceipt, type VerificationCheck } from "../receipts/schema.js";
import {
  EAS_MULTIATTEST_ABI,
  assertAttestedEventsMatch,
  buildMultiAttestLayer,
  extractAttestedEventsFromLogs,
  type EasMultiAttestationRequest
} from "./eas-requests.js";
import {
  resolveSepoliaPreflight,
  type SepoliaReadClient
} from "./sepolia-preflight.js";
import type {
  EfsWriter,
  EfsWritePlan,
  FileWriteRequestInput,
  Hex,
  Uid,
  VerificationResult,
  WriterContext
} from "./writer.js";
import { buildFileWritePlan, collectPlannedMirrors } from "./write-plan.js";

interface SepoliaTransactionReceipt {
  status: "success" | "reverted";
  logs: readonly Log[];
  blockNumber: bigint | null;
}

const ZERO_UID = `0x${"0".repeat(64)}` as const;

export interface SepoliaPublicClient extends SepoliaReadClient {
  getBalance(args: { address: Hex }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<SepoliaTransactionReceipt>;
}

export interface SepoliaWalletClient {
  sendTransaction?(args: {
    account?: Account;
    chain?: typeof sepolia;
    to: Hex;
    value: bigint;
  }): Promise<Hex>;
  writeContract(args: {
    account?: Account;
    address: Hex;
    abi: typeof EAS_MULTIATTEST_ABI;
    chain?: typeof sepolia;
    functionName: "multiAttest";
    args: readonly [EasMultiAttestationRequest[]];
    value: bigint;
  }): Promise<Hex>;
}

export interface SepoliaWriterOptions {
  chainId: number;
  easAddress: Hex;
  indexerAddress: Hex;
  publicClient: SepoliaPublicClient;
  walletClientFactory: (privateKey: Hex) => SepoliaWalletClient;
  sponsorWallet?: SepoliaWalletClient;
  sponsorAccount?: Account;
  agentFundingTargetWei?: bigint;
  now?: () => Date;
}

export class SepoliaSubmitError extends Error {
  readonly partialReceipt?: EfsScribeReceipt;

  constructor(message: string, partialReceipt?: EfsScribeReceipt) {
    super(message);
    this.name = "SepoliaSubmitError";
    this.partialReceipt = partialReceipt;
  }
}

export class SepoliaEfsWriter implements EfsWriter {
  readonly mode = "sepolia" as const;
  private readonly chainId: number;
  private readonly easAddress: Hex;
  private readonly indexerAddress: Hex;
  private readonly publicClient: SepoliaPublicClient;
  private readonly walletClientFactory: (privateKey: Hex) => SepoliaWalletClient;
  private readonly sponsorWallet?: SepoliaWalletClient;
  private readonly sponsorAccount?: Account;
  private readonly agentFundingTargetWei: bigint;
  private readonly now: () => Date;

  constructor(options: SepoliaWriterOptions) {
    this.chainId = options.chainId;
    this.easAddress = options.easAddress;
    this.indexerAddress = options.indexerAddress;
    this.publicClient = options.publicClient;
    this.walletClientFactory = options.walletClientFactory;
    this.sponsorWallet = options.sponsorWallet;
    this.sponsorAccount = options.sponsorAccount;
    this.agentFundingTargetWei = options.agentFundingTargetWei ?? 0n;
    this.now = options.now ?? (() => new Date());
  }

  async planFile(input: FileWriteRequestInput, context: WriterContext): Promise<EfsWritePlan> {
    return buildFileWritePlan(input, context);
  }

  async submitPlan(plan: EfsWritePlan, context: WriterContext): Promise<EfsScribeReceipt> {
    if (plan.attester.toLowerCase() !== context.attester.address.toLowerCase()) {
      throw new SepoliaSubmitError("Write plan attester does not match the authenticated agent lens");
    }

    const preflight = await resolveSepoliaPreflight(plan, {
      publicClient: this.publicClient,
      indexerAddress: this.indexerAddress,
      edgeResolverAddress: EFS_SEPOLIA.edgeResolver
    });
    const refs = new Map<string, Uid>(preflight.resolvedRefs);
    const skipRefs = new Set<string>();
    for (const anchor of preflight.pathAnchors) {
      if (anchor.uid !== undefined) {
        refs.set(anchor.plannedRef, anchor.uid);
        skipRefs.add(anchor.plannedRef);
      }
    }
    for (const ref of preflight.activeVisibilityTagRefs) {
      skipRefs.add(ref);
    }

    const agentAccount = privateKeyToAccount(context.attester.privateKey);
    if (agentAccount.address.toLowerCase() !== context.attester.address.toLowerCase()) {
      throw new SepoliaSubmitError("Derived agent account does not match the authenticated lens");
    }
    await this.ensureAgentFunding(context);

    const walletClient = this.walletClientFactory(context.attester.privateKey);
    const txHashes: Hex[] = [];
    const blockNumbers: number[] = [];

    try {
      for (const layer of uniqueLayers(plan)) {
        const layerRequests = buildMultiAttestLayer(plan, layer, refs, { skipRefs });
        if (layerRequests.flatRefs.length === 0) {
          continue;
        }

        let txHash: Hex;
        try {
          txHash = await walletClient.writeContract({
            account: agentAccount,
            address: this.easAddress,
            abi: EAS_MULTIATTEST_ABI,
            functionName: "multiAttest",
            args: [layerRequests.requests],
            value: 0n,
            chain: sepolia
          });
        } catch (error) {
          throw new SepoliaSubmitError(
            `Sepolia EAS multiAttest transaction was not sent: ${errorMessage(error)}`
          );
        }
        txHashes.push(txHash);
        const receipt = await this.confirmTransaction(txHash, "Sepolia EAS multiAttest");
        blockNumbers.push(toSafeBlockNumber(receipt.blockNumber));
        const events = extractAttestedEventsFromLogs(
          receipt.logs,
          this.easAddress,
          layerRequests.flatRefs.length
        );
        assertAttestedEventsMatch({
          events,
          expectedAttester: context.attester.address,
          expectedSchemas: layerRequests.flatSchemas
        });
        const uids = events.map((event) => event.uid);
        layerRequests.flatRefs.forEach((ref, index) => {
          const uid = uids[index];
          if (uid === undefined) {
            throw new SepoliaSubmitError(`Missing EAS UID for planned ref ${ref}`);
          }
          refs.set(ref, uid);
        });
      }
    } catch (error) {
      if (txHashes.length === 0) {
        throw error;
      }
      const message = `Sepolia write failed after partial submission: ${errorMessage(error)}`;
      throw new SepoliaSubmitError(
        message,
        this.buildReceipt({
          status: "failed",
          plan,
          context,
          refs,
          txHashes,
          blockNumbers,
          failureDetail: message
        })
      );
    }

    return this.buildReceipt({
      status: "confirmed",
      plan,
      context,
      refs,
      txHashes,
      blockNumbers
    });
  }

  private buildReceipt(input: {
    status: "confirmed" | "failed";
    plan: EfsWritePlan;
    context: WriterContext;
    refs: ReadonlyMap<string, Uid>;
    txHashes: Hex[];
    blockNumbers: number[];
    failureDetail?: string;
  }): EfsScribeReceipt {
    const checkedAt = this.now().toISOString();
    const receiptId = `rcpt_${input.plan.canonicalRequestHash.slice(
      "sha256:".length,
      "sha256:".length + 24
    )}`;
    const checks = sepoliaChecks({
      chainId: this.chainId,
      easAddress: this.easAddress,
      txHashes: input.txHashes,
      blockNumbers: input.blockNumbers,
      refs: input.refs
    });
    if (input.status === "failed") {
      checks.push({
        name: "sepolia_write_failed",
        ok: false,
        detail: input.failureDetail
      });
    }
    const dataUid = receiptUid(input.refs, "data", input.status);
    const fileAnchorUid = receiptUid(input.refs, `anchor:${input.plan.path}`, input.status);
    const placementPinUid = receiptUid(input.refs, "placement.pin", input.status);
    return ReceiptSchema.parse({
      receipt_version: "efs-scribe-receipt/v1",
      receipt_id: receiptId,
      status: input.status,
      mode: "sepolia",
      operation: "file.upsert",
      created_at: checkedAt,
      auth: input.context.auth,
      agent_lens: {
        attester: input.context.attester.address,
        derivation: input.context.attester.derivation
      },
      integrity: {
        payload_sha256: input.plan.payloadHash,
        metadata_sha256: input.plan.metadataHash,
        canonical_request_sha256: input.plan.canonicalRequestHash
      },
      efs: {
        network: "sepolia",
        chain_id: this.chainId,
        eas: this.easAddress,
        tx_hashes: input.txHashes,
        block_numbers: input.blockNumbers,
        path: input.plan.path,
        mirrors: collectPlannedMirrors(input.plan),
        uids: {
          data: dataUid,
          file_anchor: fileAnchorUid,
          placement_pin: placementPinUid,
          mirrors: collectUids(input.refs, /^mirror\.\d+$/),
          properties: collectPropertyPins(input.refs)
        }
      },
      verification: {
        checked_at: checkedAt,
        checks
      },
      links: {
        self: `${input.context.publicBaseUrl}/v1/receipts/${receiptId}`,
        verify: `${input.context.publicBaseUrl}/v1/verify`,
        resolve: `${input.context.publicBaseUrl}/v1/resolve?path=${encodeURIComponent(input.plan.path)}`
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
    const checks = [
      ...sepoliaChecks({
        chainId: parsed.data.efs.chain_id,
        easAddress: parsed.data.efs.eas ?? "0x",
        txHashes: parsed.data.efs.tx_hashes,
        blockNumbers: parsed.data.efs.block_numbers,
        refs: new Map([
          ["data", parsed.data.efs.uids.data],
          [`anchor:${parsed.data.efs.path}`, parsed.data.efs.uids.file_anchor],
          ["placement.pin", parsed.data.efs.uids.placement_pin]
        ])
      }),
      {
        name: "sepolia_receipt_status",
        ok: parsed.data.status === "confirmed",
        detail: parsed.data.status === "confirmed" ? undefined : `status=${parsed.data.status}`
      },
      { name: "sepolia_network", ok: parsed.data.efs.network === "sepolia" }
    ];
    return { ok: checks.every((check) => check.ok), checks };
  }

  private async ensureAgentFunding(context: WriterContext): Promise<void> {
    if (this.agentFundingTargetWei === 0n) {
      return;
    }
    if (this.sponsorWallet?.sendTransaction === undefined) {
      throw new SepoliaSubmitError("Sepolia agent funding is enabled but no sponsor wallet is configured");
    }

    const balance = await this.publicClient.getBalance({ address: context.attester.address });
    if (balance >= this.agentFundingTargetWei) {
      return;
    }

    const value = this.agentFundingTargetWei - balance;
    let txHash: Hex;
    try {
      txHash = await this.sponsorWallet.sendTransaction({
        account: this.sponsorAccount,
        chain: sepolia,
        to: context.attester.address,
        value
      });
    } catch (error) {
      throw new SepoliaSubmitError(
        `Sepolia agent wallet funding transaction was not sent: ${errorMessage(error)}`
      );
    }
    await this.confirmTransaction(txHash, "Sepolia agent wallet funding");
  }

  private async confirmTransaction(hash: Hex, label: string): Promise<SepoliaTransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new SepoliaSubmitError(`${label} transaction reverted`);
    }
    if (receipt.blockNumber === null) {
      throw new SepoliaSubmitError(`${label} transaction did not include a block number`);
    }
    return receipt;
  }
}

export function createSepoliaEfsWriter(config: AppConfig): SepoliaEfsWriter {
  const rpcUrl = config.sepolia.rpcUrl;
  const sponsorPrivateKey = config.sepolia.serviceSponsorPrivateKey;
  if (!config.sepolia.ready || rpcUrl === undefined) {
    throw new Error(`Sepolia writer requires: ${config.sepolia.missing.join(", ")}`);
  }
  if (config.sepolia.agentFundingTargetWei > 0n && sponsorPrivateKey === undefined) {
    throw new Error("Sepolia writer requires SERVICE_SPONSOR_PRIVATE_KEY when agent funding is enabled");
  }
  if (config.chainId !== sepolia.id) {
    throw new Error("Sepolia writer requires EFS_CHAIN_ID=11155111");
  }

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl)
  }) as SepoliaPublicClient;
  const sponsorAccount =
    sponsorPrivateKey === undefined ? undefined : privateKeyToAccount(sponsorPrivateKey);
  const sponsorWallet =
    sponsorAccount === undefined
      ? undefined
      : (createWalletClient({
          account: sponsorAccount,
          chain: sepolia,
          transport: http(rpcUrl)
        }) as SepoliaWalletClient);

  return new SepoliaEfsWriter({
    chainId: config.chainId,
    easAddress: config.sepolia.easAddress,
    indexerAddress: EFS_SEPOLIA.indexer,
    publicClient,
    sponsorWallet,
    sponsorAccount,
    agentFundingTargetWei: config.sepolia.agentFundingTargetWei,
    walletClientFactory: (privateKey) => {
      const account = privateKeyToAccount(privateKey);
      return createWalletClient({
        account,
        chain: sepolia,
        transport: http(rpcUrl)
      }) as SepoliaWalletClient;
    }
  });
}

function uniqueLayers(plan: EfsWritePlan): number[] {
  return [...new Set(plan.layers.map((attestation) => attestation.layer))].sort(
    (left, right) => left - right
  );
}

function receiptUid(
  refs: ReadonlyMap<string, Uid>,
  ref: string,
  status: "confirmed" | "failed"
): Uid {
  const uid = refs.get(ref);
  if (uid !== undefined) {
    return uid;
  }
  if (status === "failed") {
    return ZERO_UID;
  }
  throw new SepoliaSubmitError(`Missing submitted EFS ref ${ref}`);
}

function collectUids(refs: ReadonlyMap<string, Uid>, pattern: RegExp): Uid[] {
  return [...refs.entries()]
    .filter(([ref]) => pattern.test(ref))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, uid]) => uid);
}

function collectPropertyPins(refs: ReadonlyMap<string, Uid>): Record<string, Uid> {
  const properties: Record<string, Uid> = {};
  for (const [ref, uid] of refs.entries()) {
    const match = /^property:(.*)\.pin$/.exec(ref);
    if (match?.[1] !== undefined) {
      properties[match[1]] = uid;
    }
  }
  return Object.fromEntries(
    Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, Uid>;
}

function sepoliaChecks(input: {
  chainId: number;
  easAddress: Hex;
  txHashes: Hex[];
  blockNumbers: number[];
  refs: ReadonlyMap<string, Uid>;
}): VerificationCheck[] {
  return [
    { name: "sepolia_receipt_shape", ok: true },
    { name: "sepolia_chain_id", ok: input.chainId === 11155111 },
    { name: "sepolia_eas_address", ok: /^0x[0-9a-fA-F]{40}$/.test(input.easAddress) },
    {
      name: "sepolia_tx_hashes",
      ok:
        input.txHashes.length > 0 &&
        input.txHashes.every((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash))
    },
    {
      name: "sepolia_block_numbers",
      ok: input.blockNumbers.length === input.txHashes.length
    },
    { name: "sepolia_data_uid", ok: isUid(input.refs.get("data")) },
    {
      name: "sepolia_file_anchor_uid",
      ok: [...input.refs.entries()].some(([ref, uid]) => ref.startsWith("anchor:/") && isUid(uid))
    },
    { name: "sepolia_placement_pin_uid", ok: isUid(input.refs.get("placement.pin")) }
  ];
}

function isUid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(value) &&
    value.toLowerCase() !== ZERO_UID
  );
}

function toSafeBlockNumber(blockNumber: bigint | null): number {
  if (blockNumber === null || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SepoliaSubmitError("Sepolia receipt block number cannot be represented safely");
  }
  return Number(blockNumber);
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const record = error as { shortMessage?: unknown; message?: unknown };
    if (typeof record.shortMessage === "string") {
      return record.shortMessage;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return String(error);
}
