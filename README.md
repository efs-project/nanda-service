# EFS Scribe

Agent-friendly EFS write receipts for local development and Sepolia demo work.

EFS Scribe gives agents a simple HTTP API for publishing EFS-shaped file records,
previewing the EFS attestation plan, receiving receipts, resolving stored
receipts by path, and verifying receipts later. The current implementation ships
a deterministic `offline` writer for local development, tests, and Nanda
Town-style simulation. The same API is being prepared for a Sepolia writer that
records real EFS attestations.

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

The plan includes a `preflight` list naming Sepolia facts a real chain writer
must resolve first, such as `rootAnchorUID`, existing path anchors, and
`/transports/<name>` anchors.

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
- `sepolia`: planned for the real Sepolia EFS writer. The server rejects this
  mode until the writer is implemented.

Both modes use the same request and receipt shape.

The codebase includes read-only Sepolia preflight helpers for resolving
`rootAnchorUID`, path anchors, and `/transports/<name>` anchors before the real
submitter sends EAS transactions.

## Safety

Do not write secrets, private keys, personal data, or confidential URLs. EFS
receipts are meant to be independently inspectable claims about content hashes
and metadata, not private storage.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
