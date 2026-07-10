import type { IpfsConfig } from "../config/env.js";

const IPFS_ADD_ATTEMPTS = 3;
const IPFS_ADD_TIMEOUT_MS = 60_000;
const IPFS_READ_ATTEMPTS = 3;
const IPFS_READ_TIMEOUT_MS = 60_000;
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

export interface ReadFromIpfsResult {
  bytes: Buffer;
  contentType?: string;
  gatewayUrl: string;
}

export class IpfsPinningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpfsPinningError";
  }
}

export class IpfsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpfsReadError";
  }
}

class FinalIpfsPinningError extends IpfsPinningError {}
class FinalIpfsReadError extends IpfsReadError {}

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

export async function readFromIpfs(
  config: IpfsConfig,
  input: { uri: string; maxBytes: number }
): Promise<ReadFromIpfsResult> {
  const url = ipfsGatewayUrlForUri(config, input.uri);

  let lastError: unknown;
  for (let attempt = 1; attempt <= IPFS_READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(IPFS_READ_TIMEOUT_MS)
      });
      if (response.ok) {
        return {
          bytes: await readResponseBytes(response, input.maxBytes),
          contentType: response.headers.get("content-type") ?? undefined,
          gatewayUrl: url.toString()
        };
      }
      if (!isTransientStatus(response.status) || attempt === IPFS_READ_ATTEMPTS) {
        throw new FinalIpfsReadError(`IPFS gateway fetch failed with HTTP ${response.status}`);
      }
      lastError = new IpfsReadError(`IPFS gateway fetch failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error instanceof FinalIpfsReadError || attempt === IPFS_READ_ATTEMPTS) {
        break;
      }
    }

    await sleep(IPFS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }

  throw ipfsReadErrorFrom(lastError);
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

function ipfsGatewayUrlForUri(config: IpfsConfig, uri: string): URL {
  const cid = cidFromIpfsUri(uri);
  const gatewayBase = config.gatewayUrl ?? gatewayFromApiUrl(config.apiUrl);
  if (gatewayBase === undefined) {
    throw new IpfsReadError("IPFS gateway URL is not configured");
  }
  try {
    const base = gatewayBase.endsWith("/") ? gatewayBase : `${gatewayBase}/`;
    return new URL(encodeURIComponent(cid), base);
  } catch {
    throw new IpfsReadError("IPFS gateway URL is invalid");
  }
}

function gatewayFromApiUrl(apiUrl: string | undefined): string | undefined {
  if (apiUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(/\/api\/v0\/?$/, "/ipfs/");
    if (!url.pathname.endsWith("/ipfs/")) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function cidFromIpfsUri(uri: string): string {
  if (!uri.startsWith("ipfs://")) {
    throw new IpfsReadError("IPFS mirror URI must start with ipfs://");
  }
  const cid = uri.slice("ipfs://".length);
  if (!/^[A-Za-z0-9]+$/.test(cid)) {
    throw new IpfsReadError("IPFS mirror URI must contain a bare CID");
  }
  return cid;
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

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new IpfsReadError(`IPFS response exceeded ${maxBytes} bytes`);
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new IpfsReadError(`IPFS response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
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

function ipfsReadErrorFrom(error: unknown): IpfsReadError {
  if (error instanceof IpfsReadError) {
    return error;
  }
  if (error instanceof Error) {
    return new IpfsReadError(`IPFS gateway fetch failed: ${error.message}`);
  }
  return new IpfsReadError("IPFS gateway fetch failed");
}
