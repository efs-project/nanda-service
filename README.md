# EFS Scribe

Agent-friendly EFS write receipts for local development and Sepolia demo work.

EFS Scribe gives agents a simple HTTP API for publishing EFS file records,
previewing the EFS attestation plan, receiving receipts, resolving stored
receipts by path, and verifying receipts later. It ships two modes:
deterministic `offline` receipts for local development, and configured
`sepolia` writes that submit real EAS `multiAttest` transactions.

## Quick Start

```bash
npm install
npm run dev
```

The local default API key is `demo-key`.

```bash
curl http://localhost:3000/health
curl http://localhost:3000/v1/capabilities
```

Preview the EFS plan for a write:

```bash
curl -X POST http://localhost:3000/v1/files/plan \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer demo-key' \
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
with `contentHash`, `contentType`, and `size` bound as PROPERTYs. Retrievable
bytes should be supplied through explicit mirrors such as `https` or `ipfs`;
`inline_base64` is used to compute the content facts.

Write a small JSON file in offline mode:

```bash
curl -X POST http://localhost:3000/v1/files \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer demo-key' \
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

## Modes

- `offline`: deterministic mock EFS receipts. No network or wallet required.
- `sepolia`: real Sepolia EFS writes through EAS `multiAttest`. The derived
  per-agent wallet signs as the EAS attester, and the sponsor key can top that
  wallet up with Sepolia ETH.

Both modes use the same request and receipt shape.

Sepolia mode requires:

```bash
EFS_SCRIBE_MODE=sepolia
API_KEYS_JSON={"your-api-key":"api-key:your-agent"}
AGENT_KEY_DERIVATION_SECRET=<random deployment secret>
SEPOLIA_RPC_URL=<rpc url>
SERVICE_SPONSOR_PRIVATE_KEY=<private key with Sepolia ETH>
```

If derived agent wallets are funded another way, set
`SEPOLIA_AGENT_FUNDING_TARGET_WEI=0` and omit `SERVICE_SPONSOR_PRIVATE_KEY`.
The sample `demo-key` is rejected in Sepolia mode.

Receipt lookup is currently memory-only. On-chain writes remain on Sepolia, but
`GET /v1/receipts/:id` and `GET /v1/resolve` only know receipts created since
the current service process started.

`agent.claimed_nanda_id` is a label supplied by the caller. The API key subject
is what controls the derived EFS attester lens.

## Limits

- Inline files are limited to 4096 decoded bytes and are used to compute
  content facts. Add explicit mirrors when the bytes should be retrievable.
- Larger files should use `hash_only` or `external_mirror_only` with one or more
  mirrors.
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
