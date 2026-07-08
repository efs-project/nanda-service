# EFS Scribe

Agent-friendly EFS writes, reads, and receipts on Sepolia.

EFS Scribe gives agents a simple HTTP API for publishing EFS-shaped file
records, receiving receipts, and verifying those receipts later. The first
implementation includes a deterministic `offline` writer for local development,
tests, and Nanda Town-style simulation. The same API is designed for a Sepolia
writer that records real EFS attestations.

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

## Modes

- `offline`: deterministic mock EFS receipts. No network or wallet required.
- `sepolia`: reserved for the real Sepolia EFS writer.

Both modes use the same request and receipt shape.

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
