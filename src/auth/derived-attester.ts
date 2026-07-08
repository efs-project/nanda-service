import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DERIVATION = "efs-scribe/sepolia/v1";

export interface DerivedAttester {
  address: Hex;
  privateKey: Hex;
  derivation: typeof DERIVATION;
  chainId: number;
}

export function deriveAttester(input: {
  subject: string;
  secret: string;
  chainId: number;
}): DerivedAttester {
  if (input.secret.trim().length < 8) {
    throw new Error("AGENT_KEY_DERIVATION_SECRET must be at least 8 characters");
  }

  const material = `${DERIVATION}:${input.chainId}:${input.subject}:${input.secret}`;
  const privateKey = keccak256(toBytes(material));
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    privateKey,
    derivation: DERIVATION,
    chainId: input.chainId
  };
}
