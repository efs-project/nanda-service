# EFS Scribe

Agent-friendly EFS write receipts for local development and Sepolia testnet work.

EFS Scribe gives agents a simple HTTP API for publishing and removing EFS file
records, pinning supplied bytes to IPFS when configured, previewing the EFS
attestation plan, receiving receipts, resolving stored receipts by path, and
verifying receipts later. It ships two modes: deterministic `offline` receipts
for local development, and configured `sepolia` writes/removals that submit
real EAS transactions.

## Quick Start

```bash
npm install
npm run dev
```

The local default API key is `local-scribe-key`. The default local key is
delete-enabled; public hosted keys should usually omit `allow_delete`.

Set `IPFS_API_URL` to a Kubo-compatible API such as
`http://127.0.0.1:5001/api/v0` when you want inline bytes pinned to IPFS by
default. EFS Scribe treats IPFS pinning as best-effort infrastructure: it
retries transient failures, limits service-side IPFS operations per
authenticated actor, rate-limits file writes, and keeps concurrent IPFS adds
low.

```bash
curl http://localhost:3000/health
curl http://localhost:3000/v1/capabilities
```

Preview the EFS plan for a write:

```bash
curl -X POST http://localhost:3000/v1/files/plan \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-scribe-key' \
  -d '{
    "path": "/agents/demo/status.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZX0=",
      "content_type": "application/json"
    },
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:demo" },
    "options": { "idempotency_key": "demo-status-001" }
  }'
```

The plan includes a `preflight` list naming Sepolia facts the chain writer
resolves first, such as `rootAnchorUID`, existing path anchors, and
`/transports/<name>` anchors. DATA itself is the EFS empty identity attestation,
with `contentHash`, `contentType`, and `size` bound as PROPERTYs. When
`IPFS_API_URL` is configured, `inline_base64` input is pinned to IPFS and the
EFS record gets an `ipfs://...` MIRROR. Without IPFS pinning, inline bytes are
used only to compute content facts and are not retrievable from the EFS record.

Write a small JSON file in offline mode:

```bash
curl -X POST http://localhost:3000/v1/files \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-scribe-key' \
  -d '{
    "path": "/agents/demo/status.json",
    "content": {
      "mode": "inline_base64",
      "content_base64": "eyJvayI6dHJ1ZX0=",
      "content_type": "application/json"
    },
    "properties": { "name": "status.json" },
    "agent": { "claimed_nanda_id": "agent:demo" },
    "options": { "idempotency_key": "demo-status-001" }
  }'
```

Then send the returned `receipt` to `POST /v1/verify`.

Remove the file from the authenticated agent lens:

```bash
curl -X POST http://localhost:3000/v1/files/delete \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-scribe-key' \
  -d '{
    "path": "/agents/demo/status.json",
    "agent": { "claimed_nanda_id": "agent:demo" },
    "options": { "idempotency_key": "demo-status-delete-001" }
  }'
```

On Sepolia, removal revokes the caller's active placement PIN for that path.
It does not erase earlier EAS attestations, chain history, mirrors, or IPFS
pins.

For `POST /v1/files/plan`, IPFS is asked to calculate the CID without pinning.
For `POST /v1/files`, the same inline bytes are pinned before the EFS write.

To preview without storing a receipt, either use `POST /v1/files/plan` or set
`"dry_run": true` in `options`.

Fetch the receipt again:

```bash
curl http://localhost:3000/v1/receipts/<receipt_id>
```

Resolve the latest stored receipt for a path:

```bash
curl 'http://localhost:3000/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json'
```

Receipts and resolve responses include mirror metadata such as
`{ "transport": "ipfs", "uri": "ipfs://..." }` when retrievable bytes are
declared.

## Modes

- `offline`: deterministic mock EFS receipts. No network or wallet required.
- `sepolia`: real Sepolia EFS writes/removals through EAS `multiAttest` and
  `multiRevoke`. The derived per-agent wallet signs as the EAS attester, and
  the sponsor key can top that wallet up with Sepolia ETH.

Both modes use the same request and receipt shape.

Sepolia mode requires:

```bash
EFS_SCRIBE_MODE=sepolia
API_KEYS_JSON={"your-api-key":"api-key:your-agent"}
AGENT_KEY_DERIVATION_SECRET=<random deployment secret>
PUBLIC_BASE_URL=https://your-public-service.example
SEPOLIA_RPC_URL=<rpc url>
SERVICE_SPONSOR_PRIVATE_KEY=<private key with Sepolia ETH>
IPFS_API_URL=<kubo api url, recommended for retrievable files>
# Optional, only if the IPFS API is protected by a reverse proxy.
IPFS_API_AUTHORIZATION=<literal Authorization header value>
```

Use an object grant when a key should be allowed to delete files:

```bash
API_KEYS_JSON={"your-private-key":{"subject":"api-key:your-agent","allow_delete":true}}
```

String grants, such as `{"public-key":"api-key:public-agent"}`, can plan and
write but cannot delete. This is the safer shape for shared hackathon keys.

On Railway, set `PUBLIC_BASE_URL` to the public Railway domain so receipt links
point back to the hosted service instead of localhost.

If derived agent wallets are funded another way, set
`SEPOLIA_AGENT_FUNDING_TARGET_WEI=0` and omit `SERVICE_SPONSOR_PRIVATE_KEY`.
The default automatic top-up target is 0.05 Sepolia ETH per derived agent wallet.
Positive non-zero targets below 0.05 Sepolia ETH are rounded up to that floor.
The sample `local-scribe-key` is rejected in Sepolia mode.

Receipt lookup is currently memory-only. On-chain writes remain on Sepolia, but
`GET /v1/receipts/:id` and `GET /v1/resolve` only know receipts created since
the current service process started.

`POST /v1/verify` checks receipt shape and self-consistency. It does not yet
re-query Sepolia or act as an independent EAS indexer.

`agent.claimed_nanda_id` is a label supplied by the caller. The API key subject
is what controls the derived EFS attester lens.

## Limits

- Inline request bodies are limited to 10 MB decoded bytes.
- With `IPFS_API_URL` configured, inline bytes default to an `ipfs://` mirror.
- Service-side IPFS operations use a 10-request burst with a 5-request/minute
  refill per authenticated actor.
- File writes and removals also use a 10-request burst with a 5-request/minute
  refill per authenticated actor.
- Scribe runs at most 2 concurrent IPFS adds per service process.
- Each service-side IPFS operation may retry transient upstream failures up to
  3 total attempts. Upstream `429` responses are not retried.
- Use `options.storage = "metadata_only"` to skip service-side IPFS pinning.
- Use `options.storage = "ipfs"` to require service-side IPFS pinning and fail
  if it is not configured.
- Use `hash_only` when you only want an EFS commitment to a hash. Hash-only is
  cheaper but does not make bytes retrievable.
- Larger files should be pinned elsewhere and submitted as
  `external_mirror_only` with one or more mirrors.
- A request can include up to 8 mirrors and 32 properties.

## Safety

Do not write secrets, private keys, personal data, or confidential URLs. EFS
records are public attestations about file identity, retrieval, and metadata,
not private storage.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
