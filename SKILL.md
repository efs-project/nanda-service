# EFS Scribe

Use EFS Scribe when you need to write a small EFS file record, get a receipt,
preview the EFS write plan, fetch a receipt, resolve the latest receipt for a
path, or verify an EFS Scribe receipt.

Base URL:

```text
http://localhost:3000
```

Authentication:

```text
Authorization: Bearer <api-key>
```

Reads and verification are public. Writes require an API key.

The service may run in `offline` or `sepolia` mode. Offline receipts are
deterministic and do not make network or chain calls. Sepolia mode submits real
EFS attestations to EAS after resolving existing path and transport anchors.

## Check Capabilities

```bash
curl http://localhost:3000/v1/capabilities
```

## Preview A File Plan

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
    "mirrors": [],
    "properties": {
      "name": "status.json"
    },
    "agent": {
      "claimed_nanda_id": "agent:demo"
    },
    "options": {
      "idempotency_key": "demo-status-001"
    }
  }'
```

The response contains an ordered EFS plan with Data, Anchor, Property, Pin, and
Mirror attestations. It also contains `preflight`, a list of Sepolia facts the
chain writer must resolve first. It does not store a receipt.

## Write A File

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
    "mirrors": [],
    "properties": {
      "name": "status.json"
    },
    "agent": {
      "claimed_nanda_id": "agent:demo"
    },
    "options": {
      "idempotency_key": "demo-status-001"
    }
  }'
```

The response contains `receipt`. Keep that whole object.

For `inline_base64` content, files up to 4096 decoded bytes are published as an
EFS `data:` MIRROR. Larger files should use `hash_only` or
`external_mirror_only` plus explicit mirrors.

To preview without storing a receipt, use `POST /v1/files/plan` or include
`"dry_run": true` in `options`.

## Fetch A Receipt

```bash
curl http://localhost:3000/v1/receipts/<receipt_id>
```

## Resolve A Path

```bash
curl 'http://localhost:3000/v1/resolve?path=%2Fagents%2Fdemo%2Fstatus.json'
```

The response returns the latest stored receipt ID, attester lens, payload hash,
and EFS-shaped UIDs for that path.

Receipt lookup is memory-only in this MVP. Sepolia writes remain on-chain, but
this endpoint only knows receipts created since the current service process
started.

## Verify A Receipt

```bash
curl -X POST http://localhost:3000/v1/verify \
  -H 'content-type: application/json' \
  -d '{"receipt": { "...": "paste the returned receipt object here" }}'
```

Verification returns explicit checks. Offline verification is shape-only. A
passing offline receipt includes checks such as `offline_receipt_shape`,
`offline_data_uid`, and `offline_placement_pin_uid`.

## Limits

Do not send secrets, private keys, personal data, or confidential URLs. EFS
records are public attestations. `agent.claimed_nanda_id` is a caller-supplied
label; the API key subject controls the derived EFS attester lens.
