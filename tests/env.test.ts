import { describe, expect, it } from "vitest";

import { EFS_SEPOLIA } from "../src/config/chains.js";
import { parseEnv } from "../src/config/env.js";

describe("parseEnv", () => {
  it("models Sepolia config readiness without accepting placeholders", () => {
    const config = parseEnv({
      EFS_SCRIBE_MODE: "sepolia",
      API_KEYS_JSON: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      AGENT_KEY_DERIVATION_SECRET: "offline-development-secret",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: "3000",
      LOG_LEVEL: "silent",
      EFS_CHAIN_ID: "11155111",
      EFS_EAS_ADDRESS: EFS_SEPOLIA.eas,
      SEPOLIA_RPC_URL: "",
      SERVICE_SPONSOR_PRIVATE_KEY: "",
      RECEIPT_SIGNER_PRIVATE_KEY: ""
    });

    expect(config.sepolia.ready).toBe(false);
    expect(config.sepolia.missing).toEqual([
      "SEPOLIA_RPC_URL",
      "SERVICE_SPONSOR_PRIVATE_KEY",
      "AGENT_KEY_DERIVATION_SECRET"
    ]);
  });

  it("accepts complete Sepolia config as ready", () => {
    const config = parseEnv({
      EFS_SCRIBE_MODE: "sepolia",
      API_KEYS_JSON: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      AGENT_KEY_DERIVATION_SECRET: "realistic-non-default-derivation-secret",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: "3000",
      LOG_LEVEL: "silent",
      EFS_CHAIN_ID: "11155111",
      EFS_EAS_ADDRESS: EFS_SEPOLIA.eas,
      SEPOLIA_RPC_URL: "https://sepolia.example.test/rpc",
      IPFS_API_URL: "http://127.0.0.1:5001/api/v0",
      IPFS_GATEWAY_URL: "https://ipfs.io/ipfs/",
      IPFS_API_AUTHORIZATION: "Bearer local-ipfs-token",
      SERVICE_SPONSOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      RECEIPT_SIGNER_PRIVATE_KEY: `0x${"2".repeat(64)}`
    });

    expect(config.sepolia).toMatchObject({
      ready: true,
      missing: [],
      rpcUrl: "https://sepolia.example.test/rpc",
      easAddress: EFS_SEPOLIA.eas,
      agentFundingTargetWei: 20_000_000_000_000_000n
    });
    expect(config.ipfs).toEqual({
      apiUrl: "http://127.0.0.1:5001/api/v0",
      gatewayUrl: "https://ipfs.io/ipfs/",
      authorization: "Bearer local-ipfs-token"
    });
  });

  it("allows Sepolia mode without a sponsor key when automatic agent funding is disabled", () => {
    const config = parseEnv({
      EFS_SCRIBE_MODE: "sepolia",
      API_KEYS_JSON: '{"local-scribe-key":"api-key:local-scribe-agent"}',
      AGENT_KEY_DERIVATION_SECRET: "realistic-non-default-derivation-secret",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: "3000",
      LOG_LEVEL: "silent",
      EFS_CHAIN_ID: "11155111",
      EFS_EAS_ADDRESS: EFS_SEPOLIA.eas,
      SEPOLIA_RPC_URL: "https://sepolia.example.test/rpc",
      SEPOLIA_AGENT_FUNDING_TARGET_WEI: "0",
      SERVICE_SPONSOR_PRIVATE_KEY: "",
      RECEIPT_SIGNER_PRIVATE_KEY: ""
    });

    expect(config.sepolia.ready).toBe(true);
    expect(config.sepolia.serviceSponsorPrivateKey).toBeUndefined();
    expect(config.sepolia.agentFundingTargetWei).toBe(0n);
  });

  it("does not mark Sepolia mode ready with a non-Sepolia chain id", () => {
    const config = parseEnv({
      EFS_SCRIBE_MODE: "sepolia",
      API_KEYS_JSON: '{"real-key":"api-key:real-agent"}',
      AGENT_KEY_DERIVATION_SECRET: "realistic-non-default-derivation-secret",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: "3000",
      LOG_LEVEL: "silent",
      EFS_CHAIN_ID: "1",
      EFS_EAS_ADDRESS: EFS_SEPOLIA.eas,
      SEPOLIA_RPC_URL: "https://sepolia.example.test/rpc",
      SEPOLIA_AGENT_FUNDING_TARGET_WEI: "0",
      SERVICE_SPONSOR_PRIVATE_KEY: "",
      RECEIPT_SIGNER_PRIVATE_KEY: ""
    });

    expect(config.sepolia.ready).toBe(false);
    expect(config.sepolia.missing).toContain("EFS_CHAIN_ID");
  });
});
