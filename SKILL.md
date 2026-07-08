# EFS Scribe

Use EFS Scribe when you need to write a small EFS file record, get a receipt,
or verify an EFS Scribe receipt.

Base URL:

```text
http://localhost:3000
```

Authentication:

```text
Authorization: Bearer <api-key>
```

Reads and verification are public. Writes require an API key.

## Check Capabilities

```bash
curl http://localhost:3000/v1/capabilities
```

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

## Verify A Receipt

```bash
curl -X POST http://localhost:3000/v1/verify \
  -H 'content-type: application/json' \
  -d '{"receipt": { "...": "paste the returned receipt object here" }}'
```

Verification returns explicit checks. A passing offline receipt includes checks
such as `offline_receipt_shape`, `offline_data_uid`, and
`offline_placement_pin_uid`.

## Limits

Do not send secrets, private keys, personal data, or confidential URLs. Receipts
are designed for independent verification of content hashes and EFS-shaped
metadata.
