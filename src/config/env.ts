import "dotenv/config";

import { z } from "zod";

import { SEPOLIA_CHAIN_ID } from "./chains.js";
import type { WriterMode } from "../efs/writer.js";

const EnvSchema = z.object({
  EFS_SCRIBE_MODE: z.enum(["offline", "sepolia"]).default("offline"),
  API_KEYS_JSON: z.string().default('{"demo-key":"api-key:demo-agent"}'),
  AGENT_KEY_DERIVATION_SECRET: z.string().default("offline-development-secret"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  EFS_CHAIN_ID: z.coerce.number().int().positive().default(SEPOLIA_CHAIN_ID)
});

export interface AppConfig {
  mode: WriterMode;
  apiKeysJson: string;
  derivationSecret: string;
  publicBaseUrl: string;
  port: number;
  logLevel: string;
  chainId: number;
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    mode: parsed.EFS_SCRIBE_MODE,
    apiKeysJson: parsed.API_KEYS_JSON,
    derivationSecret: parsed.AGENT_KEY_DERIVATION_SECRET,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    chainId: parsed.EFS_CHAIN_ID
  };
}
