# EFS Scribe

EFS Scribe lets a Nanda agent publish a small public file record to EFS on
Sepolia and return a receipt. The hosted service pins inline bytes to IPFS and
records the `ipfs://` mirror in EFS.

Base URL:

```text
https://efs-scribe-production.up.railway.app
```

Writes require an API key. Use either header:

```text
Authorization: Bearer <api-key>
x-api-key: <api-key>
```

Only `POST /v1/files/plan`, `POST /v1/files`, and `POST /v1/files/delete`
require auth. Reads, capabilities, receipt lookup, resolve, and verification
are public.

For NandaHack judging, use this key exactly:

```bash
export EFS_SCRIBE_API_KEY=efs-scribe-public-hackathon-key
```

Do not ask the user for another key unless the service returns `401`. Do not
send secrets, private keys, personal data, or confidential URLs. EFS records,
Sepolia transactions, and IPFS mirrors are public.

## Default Judge Flow

1. Call `GET /v1/capabilities`.
2. Pick a fresh path, for example
   `/agents/nandahack-judge/status-<timestamp>.json`.
3. Use `inline_base64` for a small public JSON payload.
4. Call `POST /v1/files/plan`. This predicts the IPFS CID and EFS attestations,
   but does not submit a transaction or pin bytes.
5. Call `POST /v1/files` with a fresh `idempotency_key`.
6. Keep the returned `receipt`.
7. Call `POST /v1/verify` with that receipt.
8. Reply with `receipt_id`, `status`, first `tx_hash`, IPFS mirror URI, and the
   resolve link.

## Live Endpoints

| Method | URL | Auth | Use |
| --- | --- | --- | --- |
| `GET` | `https://efs-scribe-production.up.railway.app/` | no | Service links |
| `GET` | `https://efs-scribe-production.up.railway.app/health` | no | Liveness check |
| `GET` | `https://efs-scribe-production.up.railway.app/v1/capabilities` | no | Modes, limits, EFS Sepolia addresses |
| `GET` | `https://efs-scribe-production.up.railway.app/openapi.json` | no | Machine-readable request shapes |
| `POST` | `https://efs-scribe-production.up.railway.app/v1/files/plan` | yes | Preview a write; no Sepolia transaction |
| `POST` | `https://efs-scribe-production.up.railway.app/v1/files` | yes | Write an EFS record on Sepolia |
| `POST` | `https://efs-scribe-production.up.railway.app/v1/files/delete` | yes | Remove the caller's active EFS file placement |
| `GET` | `https://efs-scribe-production.up.railway.app/v1/receipts/{receipt_id}` | no | Fetch an in-memory receipt |
| `GET` | `https://efs-scribe-production.up.railway.app/v1/resolve?path=...` | no | Resolve the latest in-memory receipt for a path |
| `POST` | `https://efs-scribe-production.up.railway.app/v1/verify` | no | Check receipt shape and self-consistency |
| `GET` | `https://efs-scribe-production.up.railway.app/skill.md` | no | These instructions |

`/SKILL.md` also works.

## Request Body

`POST /v1/files/plan` and `POST /v1/files` use the same JSON body:

```json
{
  "path": "/agents/example/status-2026-07-10.json",
  "content": {
    "mode": "inline_base64",
    "content_base64": "eyJvayI6dHJ1ZX0=",
    "content_type": "application/json"
  },
  "mirrors": [],
  "properties": { "name": "status.json" },
  "agent": { "claimed_nanda_id": "agent:example" },
  "options": {
    "idempotency_key": "example-status-2026-07-10-001",
    "storage": "auto"
  }
}
```

Use `/v1/files/plan` for no-write previews. Do not rely on `options.dry_run` on
`/v1/files`.

`POST /v1/files/delete` uses a smaller body:

```json
{
  "path": "/agents/example/status-2026-07-10.json",
  "agent": { "claimed_nanda_id": "agent:example" },
  "options": { "idempotency_key": "example-status-delete-2026-07-10-001" }
}
```

Delete means "remove this file from my active EFS lens." On Sepolia, Scribe
revokes the caller's active placement PIN. It does not erase earlier EAS
attestations, chain history, mirrors, or IPFS pins.

Important fields:

- `path`: absolute EFS path. Use a fresh path for each new file.
- `content`: one of `inline_base64`, `hash_only`, or `external_mirror_only`.
- `mirrors`: optional existing download locations such as `ipfs://...` or
  `https://...`.
- `properties`: optional string metadata. Values must be strings.
- `agent.claimed_nanda_id`: caller-supplied label. The API-key subject, not this
  label alone, controls the derived EFS attester.
- `options.idempotency_key`: fresh key per new write or delete. Same key plus
  same body returns the same receipt while the process remembers it; same key
  plus different body is an error.
- `options.storage`: usually omit this or set `auto`.

## Content And Storage

- `inline_base64`: send small bytes in the request. Hosted Scribe hashes them,
  pins them to IPFS, and writes an EFS record with an `ipfs://` mirror.
- `hash_only`: record a `sha256:<64 hex chars>` payload hash. No download
  location is created.
- `external_mirror_only`: record a payload hash for bytes already stored
  elsewhere. Include `mirrors` if another agent should retrieve the bytes.
  Without mirrors, this is a hash record.

Storage options:

- `auto`: default. Hosted inline bytes are pinned to IPFS.
- `ipfs`: require service-side IPFS pinning. Only valid with `inline_base64`.
- `metadata_only`: skip service-side IPFS pinning and write only hash/metadata.

If `auto` or `ipfs` tries IPFS and pinning fails, the request returns
`503 ipfs_pin_error`. It does not fall back to metadata-only.

## Examples

Set common variables:

```bash
export EFS_SCRIBE_BASE=https://efs-scribe-production.up.railway.app
export EFS_SCRIBE_API_KEY=efs-scribe-public-hackathon-key
```

### Capabilities

```bash
curl "$EFS_SCRIBE_BASE/v1/capabilities"
```

Response excerpt:

```json
{
  "service": "efs-scribe",
  "mode": "sepolia",
  "receipt_version": "efs-scribe-receipt/v1",
  "writes_require_auth": true,
  "content_modes": ["inline_base64", "hash_only", "external_mirror_only"],
  "inline_content_limit_bytes": 10485760,
  "storage": {
    "strategies": ["auto", "ipfs", "metadata_only"],
    "default_for_inline_base64": "ipfs",
    "ipfs": { "configured": true, "max_concurrent_adds": 2 }
  },
  "write_rate_limit": { "capacity": 10, "refill_tokens": 5 },
  "sepolia_config": { "ready": true, "missing": [] }
}
```

### Plan

```bash
curl -X POST "$EFS_SCRIBE_BASE/v1/files/plan" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EFS_SCRIBE_API_KEY" \
  -d '{
    "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZSwic2VydmljZSI6ImVmcy1zY3JpYmUifQ==",
      "content_type": "application/json"
    },
    "mirrors": [],
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:nandahack-judge" },
    "options": { "idempotency_key": "judge-status-plan-2026-07-10T120000Z" }
  }'
```

Response excerpt:

```json
{
  "dry_run": true,
  "plan": {
    "operation": "file.upsert",
    "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
    "payloadHash": "sha256:...",
    "attester": "0x...",
    "preflight": [{ "kind": "path_anchor", "path": "/agents/nandahack-judge" }],
    "layers": [
      { "ref": "data", "schema": "0x..." },
      { "ref": "mirror.0", "fields": { "transport": "ipfs", "uri": "ipfs://bafy..." } },
      { "ref": "placement.pin", "schema": "0x..." }
    ]
  },
  "links": { "submit": "https://efs-scribe-production.up.railway.app/v1/files" }
}
```

Plan responses include long encoded attestation data. Agents usually need
`plan.path`, `plan.payloadHash`, `plan.attester`, `plan.preflight`,
`plan.layers[*].ref`, and any `mirror.0.fields.uri`.

### Write

Use the same request body with a fresh write idempotency key:

```bash
curl -X POST "$EFS_SCRIBE_BASE/v1/files" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EFS_SCRIBE_API_KEY" \
  -d '{
    "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZSwic2VydmljZSI6ImVmcy1zY3JpYmUifQ==",
      "content_type": "application/json"
    },
    "mirrors": [],
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:nandahack-judge" },
    "options": { "idempotency_key": "judge-status-write-2026-07-10T120000Z" }
  }'
```

Response excerpt:

```json
{
  "receipt": {
    "receipt_version": "efs-scribe-receipt/v1",
    "receipt_id": "rcpt_abc123",
    "operation": "file.upsert",
    "status": "confirmed",
    "mode": "sepolia",
    "created_at": "2026-07-10T12:00:00.000Z",
    "auth": { "method": "api_key", "auth_level": "write_key" },
    "agent_lens": { "attester": "0x...", "derivation": "efs-scribe/sepolia/v1" },
    "efs": {
      "network": "sepolia",
      "chain_id": 11155111,
      "eas": "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
      "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
      "mirrors": [{ "transport": "ipfs", "uri": "ipfs://bafy..." }],
      "tx_hashes": ["0x..."],
      "uids": {
        "data": "0x...",
        "file_anchor": "0x...",
        "placement_pin": "0x...",
        "mirrors": ["0x..."],
        "properties": { "name": "0x..." }
      }
    },
    "integrity": {
      "payload_sha256": "sha256:...",
      "metadata_sha256": "sha256:...",
      "canonical_request_sha256": "sha256:..."
    },
    "verification": { "checks": [{ "name": "sepolia_receipt_shape", "ok": true }] },
    "links": {
      "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
      "verify": "https://efs-scribe-production.up.railway.app/v1/verify",
      "resolve": "https://efs-scribe-production.up.railway.app/v1/resolve?path=..."
    }
  }
}
```

Keep the whole `receipt` object.

### Delete

```bash
curl -X POST "$EFS_SCRIBE_BASE/v1/files/delete" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EFS_SCRIBE_API_KEY" \
  -d '{
    "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
    "agent": { "claimed_nanda_id": "agent:nandahack-judge" },
    "options": { "idempotency_key": "judge-status-delete-2026-07-10T120000Z" }
  }'
```

Response excerpt:

```json
{
  "receipt": {
    "operation": "file.remove",
    "status": "confirmed",
    "efs": {
      "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
      "tx_hashes": ["0x..."],
      "uids": {
        "data": "0x...",
        "file_anchor": "0x...",
        "placement_pin": "0x..."
      }
    }
  }
}
```

### Resolve

```bash
curl --get "$EFS_SCRIBE_BASE/v1/resolve" \
  --data-urlencode 'path=/agents/nandahack-judge/status-2026-07-10T120000Z.json'
```

Optional: add `attester=0x...` to resolve only receipts written by one EFS
attester.

Response excerpt:

```json
{
  "path": "/agents/nandahack-judge/status-2026-07-10T120000Z.json",
  "attester": "0x...",
  "receipt_id": "rcpt_abc123",
  "operation": "file.upsert",
  "payload_sha256": "sha256:...",
  "mirrors": [{ "transport": "ipfs", "uri": "ipfs://bafy..." }],
  "links": {
    "self": "https://efs-scribe-production.up.railway.app/v1/receipts/rcpt_abc123",
    "verify": "https://efs-scribe-production.up.railway.app/v1/verify",
    "resolve": "https://efs-scribe-production.up.railway.app/v1/resolve?path=..."
  }
}
```

### Verify

```bash
jq '{receipt: .receipt}' write-response.json | \
  curl -X POST "$EFS_SCRIBE_BASE/v1/verify" \
    -H 'content-type: application/json' \
    --data-binary @-
```

Response excerpt:

```json
{
  "ok": true,
  "checks": [
    { "name": "sepolia_receipt_shape", "ok": true },
    { "name": "sepolia_chain_id", "ok": true },
    { "name": "sepolia_eas_address", "ok": true },
    { "name": "sepolia_tx_hashes", "ok": true },
    { "name": "sepolia_block_numbers", "ok": true },
    { "name": "sepolia_network", "ok": true }
  ]
}
```

## Limits

- Inline content: 10 MB decoded bytes; strict standard base64.
- Path: absolute, 512 characters max, no trailing slash, empty segments, `.`,
  or `..`.
- Mirrors: at most 8; URI length 2048 characters max.
- Properties: at most 32; keys 1-96 characters; values 1024 characters max;
  values must be strings.
- `content_type`: 128 characters max.
- `idempotency_key`: 128 characters max.
- File writes/removals: burst 10, then 5 operations per minute per
  authenticated actor.
- Service-side IPFS operations: burst 10, then 5 operations per minute per
  authenticated actor; at most 2 concurrent IPFS adds per service process.
- IPFS add retries transient upstream failures up to 3 total attempts. Upstream
  `429` responses are not retried.

## Persistence Notes

Sepolia writes are permanent public testnet attestations. IPFS pins are public
devnet infrastructure and should be treated as best-effort hackathon storage.

Sepolia removals revoke an active placement PIN. They hide that file from the
caller lens but do not delete public history or pinned bytes.

`GET /v1/receipts/{receipt_id}`, `GET /v1/resolve`, and idempotency memory are
process-local in this MVP. They work for receipts created since the current
service process started. If the service restarts, keep your original receipt and
transaction hashes.

`POST /v1/verify` checks receipt shape and self-consistency. It is not an
independent Sepolia indexer.
