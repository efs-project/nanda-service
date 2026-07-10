import type { IpfsConfig } from "../config/env.js";

const IPFS_ADD_ATTEMPTS = 3;
const IPFS_ADD_TIMEOUT_MS = 60_000;
const IPFS_RETRY_BASE_DELAY_MS = 250;

export interface IpfsAddResult {
  cid: string;
  uri: `ipfs://${string}`;
  size?: string;
}

export interface AddToIpfsInput {
  bytes: Buffer;
  contentType: string;
  filename: string;
  onlyHash: boolean;
}

export class IpfsPinningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpfsPinningError";
  }
}

class FinalIpfsPinningError extends IpfsPinningError {}

export async function addToIpfs(
  config: IpfsConfig,
  input: AddToIpfsInput
): Promise<IpfsAddResult> {
  const url = ipfsAddUrl(config.apiUrl, input.onlyHash);

  let lastError: unknown;
  for (let attempt = 1; attempt <= IPFS_ADD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers:
          config.authorization === undefined ? undefined : { authorization: config.authorization },
        body: formDataFor(input),
        signal: AbortSignal.timeout(IPFS_ADD_TIMEOUT_MS)
      });
      const body = await response.text();
      if (response.ok) {
        return parseAddResponse(body);
      }
      if (!isTransientStatus(response.status) || attempt === IPFS_ADD_ATTEMPTS) {
        throw new FinalIpfsPinningError(`IPFS add failed with HTTP ${response.status}`);
      }
      lastError = new IpfsPinningError(`IPFS add failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error instanceof FinalIpfsPinningError || attempt === IPFS_ADD_ATTEMPTS) {
        break;
      }
    }

    await sleep(IPFS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }

  throw ipfsErrorFrom(lastError);
}

export function assertValidIpfsApiUrl(apiUrl: string | undefined): void {
  if (apiUrl === undefined) {
    throw new IpfsPinningError("IPFS pinning is not configured");
  }
  ipfsAddUrl(apiUrl, false);
}

function ipfsAddUrl(apiUrl: string | undefined, onlyHash: boolean): URL {
  if (apiUrl === undefined) {
    throw new IpfsPinningError("IPFS pinning is not configured");
  }
  try {
    return addUrl(apiUrl, onlyHash);
  } catch {
    throw new IpfsPinningError("IPFS API URL is invalid");
  }
}

function formDataFor(input: AddToIpfsInput): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
    input.filename
  );
  return form;
}

function addUrl(apiUrl: string, onlyHash: boolean): URL {
  const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  const url = new URL("add", base);
  url.searchParams.set("cid-version", "1");
  url.searchParams.set("pin", onlyHash ? "false" : "true");
  if (onlyHash) {
    url.searchParams.set("only-hash", "true");
  }
  return url;
}

function parseAddResponse(body: string): IpfsAddResult {
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines.reverse()) {
    const parsed = JSON.parse(line) as { Hash?: unknown; Size?: unknown };
    if (typeof parsed.Hash === "string" && parsed.Hash.length > 0) {
      return {
        cid: parsed.Hash,
        uri: `ipfs://${parsed.Hash}`,
        size: typeof parsed.Size === "string" ? parsed.Size : undefined
      };
    }
  }

  throw new IpfsPinningError("IPFS add response did not include a CID");
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ipfsErrorFrom(error: unknown): IpfsPinningError {
  if (error instanceof IpfsPinningError) {
    return error;
  }
  if (error instanceof Error) {
    return new IpfsPinningError(`IPFS add failed: ${error.message}`);
  }
  return new IpfsPinningError("IPFS add failed");
}
