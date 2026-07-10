import "dotenv/config";

import { z } from "zod";

import { SEPOLIA_CHAIN_ID, SEPOLIA_EAS_ADDRESS } from "./chains.js";
import type { WriterMode } from "../efs/writer.js";

const DEFAULT_DERIVATION_SECRET = "offline-development-secret";

const EnvSchema = z.object({
  EFS_SCRIBE_MODE: z.enum(["offline", "sepolia"]).default("offline"),
  API_KEYS_JSON: z
    .string()
    .default('{"local-scribe-key":{"subject":"api-key:local-scribe-agent","allow_delete":true}}'),
  AGENT_KEY_DERIVATION_SECRET: z.string().default(DEFAULT_DERIVATION_SECRET),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  IPFS_API_URL: z.string().default(""),
  IPFS_GATEWAY_URL: z.string().default(""),
  IPFS_API_AUTHORIZATION: z.string().default(""),
  EFS_CHAIN_ID: z.coerce.number().int().positive().default(SEPOLIA_CHAIN_ID),
  EFS_EAS_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default(SEPOLIA_EAS_ADDRESS),
  SEPOLIA_RPC_URL: z.string().default(""),
  SEPOLIA_AGENT_FUNDING_TARGET_WEI: z.string().default("20000000000000000"),
  SERVICE_SPONSOR_PRIVATE_KEY: z.string().default(""),
  RECEIPT_SIGNER_PRIVATE_KEY: z.string().default("")
});

export interface SepoliaConfig {
  ready: boolean;
  missing: string[];
  rpcUrl?: string;
  easAddress: `0x${string}`;
  agentFundingTargetWei: bigint;
  serviceSponsorPrivateKey?: `0x${string}`;
  receiptSignerPrivateKey?: `0x${string}`;
}

export interface AppConfig {
  mode: WriterMode;
  apiKeysJson: string;
  derivationSecret: string;
  publicBaseUrl: string;
  port: number;
  logLevel: string;
  chainId: number;
  ipfs: IpfsConfig;
  sepolia: SepoliaConfig;
}

export interface IpfsConfig {
  apiUrl?: string;
  gatewayUrl?: string;
  authorization?: string;
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const sepolia = buildSepoliaConfig(parsed);
  return {
    mode: parsed.EFS_SCRIBE_MODE,
    apiKeysJson: parsed.API_KEYS_JSON,
    derivationSecret: parsed.AGENT_KEY_DERIVATION_SECRET,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    chainId: parsed.EFS_CHAIN_ID,
    ipfs: {
      apiUrl: usableUrl(parsed.IPFS_API_URL),
      gatewayUrl: usableUrl(parsed.IPFS_GATEWAY_URL),
      authorization: usableSecret(parsed.IPFS_API_AUTHORIZATION)
    },
    sepolia
  };
}

function buildSepoliaConfig(parsed: z.infer<typeof EnvSchema>): SepoliaConfig {
  const missing: string[] = [];
  const rpcUrl = usableUrl(parsed.SEPOLIA_RPC_URL);
  const agentFundingTargetWei = parseWei(parsed.SEPOLIA_AGENT_FUNDING_TARGET_WEI);
  const serviceSponsorPrivateKey = usablePrivateKey(parsed.SERVICE_SPONSOR_PRIVATE_KEY);
  const receiptSignerPrivateKey = usablePrivateKey(parsed.RECEIPT_SIGNER_PRIVATE_KEY);

  if (rpcUrl === undefined) {
    missing.push("SEPOLIA_RPC_URL");
  }
  if (parsed.EFS_SCRIBE_MODE === "sepolia" && parsed.EFS_CHAIN_ID !== SEPOLIA_CHAIN_ID) {
    missing.push("EFS_CHAIN_ID");
  }
  if (agentFundingTargetWei > 0n && serviceSponsorPrivateKey === undefined) {
    missing.push("SERVICE_SPONSOR_PRIVATE_KEY");
  }
  if (isPlaceholderSecret(parsed.AGENT_KEY_DERIVATION_SECRET)) {
    missing.push("AGENT_KEY_DERIVATION_SECRET");
  }

  return {
    ready: missing.length === 0,
    missing,
    rpcUrl,
    easAddress: parsed.EFS_EAS_ADDRESS as `0x${string}`,
    agentFundingTargetWei,
    serviceSponsorPrivateKey,
    receiptSignerPrivateKey
  };
}

function usableUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /^replace/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function usableSecret(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /^replace/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function usablePrivateKey(value: string): `0x${string}` | undefined {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed as `0x${string}`;
  }
  return undefined;
}

function parseWei(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("SEPOLIA_AGENT_FUNDING_TARGET_WEI must be a non-negative integer");
  }
  return BigInt(trimmed);
}

function isPlaceholderSecret(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length < 16 ||
    trimmed === DEFAULT_DERIVATION_SECRET ||
    /^replace/i.test(trimmed)
  );
}
