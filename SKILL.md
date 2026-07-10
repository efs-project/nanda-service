# EFS Scribe

EFS Scribe writes small EFS file records for agents and returns receipts that
can be fetched, resolved by path, and checked later. When IPFS is configured,
inline bytes are pinned to IPFS and the EFS record includes an `ipfs://` mirror.

Base URL:

```text
https://efs-scribe-production.up.railway.app
```

If you run EFS Scribe locally, replace the base URL with
`http://localhost:3000`.

Writes require an API key:

```text
Authorization: Bearer <api-key>
```

Set `EFS_SCRIBE_API_KEY` before write calls. Reads and verification are public.
The hosted service runs in Sepolia mode, so writes submit real EAS
`multiAttest` transactions. The local default mode is offline and deterministic.

For NandaHack judging, if no private key was provided separately, use this
public hackathon key:

```bash
export EFS_SCRIBE_API_KEY=efs-scribe-public-hackathon-key
```

This key is only for public hackathon evaluation writes. Do not send secrets,
private data, or confidential URLs.

The hosted service is intended for public testnet writes. `inline_base64`
content is request input; raw bytes are not stored in Sepolia attestations. By
default, Scribe pins those bytes to IPFS when pinning is available and records
the IPFS mirror in EFS. IPFS pinning is best-effort devnet infrastructure:
Scribe retries transient failures, rate-limits authenticated actors, and keeps
concurrent IPFS adds low.

## GET /

Returns service links.

```bash
curl https://efs-scribe-production.up.railway.app/
```

Example response:

```json
{
  "service": "efs-scribe",
  "mode": "sepolia",
  "summary": "Agent-friendly EFS file write receipts and write-plan previews.",
  "links": {
    "skill": "/skill.md",
    "capabilities": "/v1/capabilities",
    "write_file": "/v1/files",
    "verify_receipt": "/v1/verify"
  }
}
```

## GET /health

Checks whether the service is alive.

```bash
curl https://efs-scribe-production.up.railway.app/health
```

Example response:

```json
{ "ok": true, "service": "efs-scribe", "mode": "sepolia" }
```

## GET /skill.md

Returns these agent instructions. `/SKILL.md` also works.

```bash
curl https://efs-scribe-production.up.railway.app/skill.md
```

Example response:

```text
# EFS Scribe

EFS Scribe writes small EFS file records...
```

## GET /openapi.json

Returns a compact OpenAPI document for the service.

```bash
curl https://efs-scribe-production.up.railway.app/openapi.json
```

Example response:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "EFS Scribe API", "version": "0.1.0" },
  "paths": {
    "/v1/files": { "post": { "summary": "Write an EFS file record" } },
    "/v1/verify": { "post": { "summary": "Verify an EFS Scribe receipt" } }
  }
}
```

## GET /v1/capabilities

Returns modes, content limits, public endpoints, authenticated endpoints, and
Sepolia EFS contract/schema addresses.

```bash
curl https://efs-scribe-production.up.railway.app/v1/capabilities
```

Example response:

```json
{
  "service": "efs-scribe",
  "mode": "sepolia",
  "auth_modes": ["api_key"],
  "content_modes": ["inline_base64", "hash_only", "external_mirror_only"],
  "storage": {
    "strategies": ["auto", "ipfs", "metadata_only"],
    "default_for_inline_base64": "ipfs",
    "ipfs": {
      "configured": true,
      "plan_previews_pin": false,
      "rate_limit": {
        "capacity": 10,
        "refill_tokens": 5,
        "refill_interval_ms": 60000
      },
      "max_concurrent_adds": 2
    }
  },
  "writes_require_auth": true,
  "sepolia_config": { "ready": true, "missing": [] },
  "public_endpoints": ["/", "/health", "/skill.md", "/v1/capabilities"],
  "authenticated_endpoints": ["/v1/files/plan", "/v1/files"]
}
```

## POST /v1/files/plan

Previews the ordered EFS write plan. It does not store a receipt or submit a
chain transaction.

```bash
curl -X POST https://efs-scribe-production.up.railway.app/v1/files/plan \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EFS_SCRIBE_API_KEY" \
  -d '{
    "path": "/agents/demo/status.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZX0=",
      "content_type": "application/json"
    },
    "mirrors": [],
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:demo" },
    "options": { "idempotency_key": "demo-status-plan-001" }
  }'
```

Example response:

```json
{
  "dry_run": true,
  "plan": {
    "operation": "file.upsert",
    "path": "/agents/demo/status.json",
    "canonicalRequestHash": "sha256:...",
    "payloadHash": "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602",
    "preflight": [
      { "kind": "root_anchor", "path": "/" },
      { "kind": "path_anchor", "path": "/agents/demo/status.json" },
      { "kind": "transport_anchor", "path": "/transports/ipfs", "transport": "ipfs" }
    ],
    "layers": [
      { "ref": "data", "schema": "0x..." },
      {
        "ref": "mirror.0",
        "schema": "0x...",
        "fields": { "transport": "ipfs", "uri": "ipfs://bafy..." }
      },
      { "ref": "placement.pin", "schema": "0x..." }
    ]
  },
  "links": {
    "submit": "https://efs-scribe-production.up.railway.app/v1/files",
    "capabilities": "https://efs-scribe-production.up.railway.app/v1/capabilities"
  }
}
```

## POST /v1/files

Writes an EFS file record and returns a receipt. Use a fresh path and
`idempotency_key` for each new write.

```bash
curl -X POST https://efs-scribe-production.up.railway.app/v1/files \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EFS_SCRIBE_API_KEY" \
  -d '{
    "path": "/agents/demo/status.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZX0=",
      "content_type": "application/json"
    },
    "mirrors": [],
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:demo" },
    "options": { "idempotency_key": "demo-status-write-001" }
  }'
```

Example response:

```json
{
  "receipt": {
    "receipt_version": "efs-scribe-receipt/v1",
    "receipt_id": "rcpt_abc123",
    "status": "confirmed",
    "mode": "sepolia",
    "auth": {
      "method": "api_key",
      "auth_level": "write_key",
      "claimed_nanda_id": "agent:demo",
      "authenticated_subject": "api-key:..."
    },
    "agent_lens": {
      "attester": "0x4F1a606508cA075F8cFBE06aC30a7C7aA023e89D",
      "derivation": "hmac-sha256:..."
    },
    "efs": {
      "path": "/agents/demo/status.json",
      "mirrors": [{ "transport": "ipfs", "uri": "ipfs://bafy..." }],
      "tx_hashes": ["0x..."],
      "block_numbers": [11237712],
      "uids": {
        "data": "0x...",
        "file_anchor": "0x...",
        "placement_pin": "0x...",
        "mirrors": ["0x..."]
      }
    },
    "integrity": {
      "payload_sha256": "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602"
    },
    "links": {
      "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
      "verify": "https://efs-scribe-production.up.railway.app/v1/verify",
      "resolve": "https://efs-scribe-production.up.railway.app/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
    }
  },
  "links": {
    "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
    "verify": "https://efs-scribe-production.up.railway.app/v1/verify",
    "resolve": "https://efs-scribe-production.up.railway.app/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
  }
}
```

Keep the whole `receipt` object. You need it for verification.

## GET /v1/receipts/{receipt_id}

Fetches a stored receipt by ID.

```bash
curl https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123
```

Example response:

```json
{
  "receipt": {
    "receipt_version": "efs-scribe-receipt/v1",
    "receipt_id": "rcpt_abc123",
    "status": "confirmed",
    "mode": "sepolia"
  },
  "links": {
    "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
    "verify": "https://efs-scribe-production.up.railway.app/v1/verify",
    "resolve": "https://efs-scribe-production.up.railway.app/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json"
  }
}
```

Receipt lookup is memory-only in this MVP. Sepolia writes remain on-chain, but
this endpoint only knows receipts created since the current service process
started.

## GET /v1/resolve

Resolves the latest stored receipt for a path. This does not fetch file bytes.

```bash
curl 'https://efs-scribe-production.up.railway.app/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json'
```

Example response:

```json
{
  "path": "/agents/demo/status.json",
  "attester": "0x4F1a606508cA075F8cFBE06aC30a7C7aA023e89D",
  "receipt_id": "rcpt_abc123",
  "payload_sha256": "sha256:2689367b205c16ce32b480e6f8ebbb8a9f044d455c6ddfb140bfd6a500933602",
  "mirrors": [{ "transport": "ipfs", "uri": "ipfs://bafy..." }],
  "uids": {
    "data": "0x...",
    "file_anchor": "0x...",
    "placement_pin": "0x...",
    "mirrors": ["0x..."]
  },
  "links": {
    "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
    "verify": "https://efs-scribe-production.up.railway.app/v1/verify"
  }
}
```

## POST /v1/verify

Checks receipt shape and self-consistency. It is not an independent Sepolia
indexer.

```bash
curl -X POST https://efs-scribe-production.up.railway.app/v1/verify \
  -H 'content-type: application/json' \
  -d '{"receipt": { "...": "paste the returned receipt object here" }}'
```

Example response:

```json
{
  "ok": true,
  "checks": [
    { "name": "sepolia_receipt_shape", "ok": true },
    { "name": "sepolia_chain_id", "ok": true },
    { "name": "sepolia_tx_hashes", "ok": true },
    { "name": "sepolia_receipt_status", "ok": true }
  ]
}
```

## Recommended Agent Workflow

1. Call `GET /v1/capabilities`.
2. Choose a unique EFS path such as `/agents/<your-agent>/status-<timestamp>.json`.
3. Choose content mode:
   - `inline_base64` for small bytes you want Scribe to hash and, when
     available, pin to IPFS.
   - `hash_only` when you only want to record a payload hash.
   - `external_mirror_only` when bytes already live elsewhere.
4. Use `options.storage` only when you need to override the default:
   - `auto` is the default. Inline bytes are pinned to IPFS when configured.
   - `ipfs` requires Scribe to pin inline bytes or fail.
   - `metadata_only` skips service-side IPFS pinning.
5. Include `mirrors` such as `https` or `ipfs` if the bytes already live
   somewhere retrievable. Hash-only records prove a payload hash but do not
   provide a download location.
6. Call `POST /v1/files/plan` if you want to preview the EFS attestations.
7. Call `POST /v1/files` with a fresh `idempotency_key`.
8. Keep the returned `receipt` object.
9. Use `GET /v1/receipts/{receipt_id}` or `GET /v1/resolve?path=...` during
   the same service run to find the receipt again.
10. Send the whole receipt to `POST /v1/verify` when you need explicit checks.

## Limits And Safety

Do not send secrets, private keys, personal data, or confidential URLs. EFS
records are public attestations.

Inline request bodies are limited to 10 MB decoded bytes. Larger files should be
pinned elsewhere and submitted as `external_mirror_only` with an `ipfs://` or
`https://` mirror.

Service-side IPFS pinning is rate-limited per authenticated actor: burst 10,
then 5 IPFS operations per minute. Plan previews also count because they call
IPFS in `only-hash` mode. A service-side IPFS operation may retry transient
upstream failures up to 3 total attempts. Upstream `429` responses are not
retried.

`agent.claimed_nanda_id` is a caller-supplied label. The authenticated API-key
subject controls the derived EFS attester lens.
