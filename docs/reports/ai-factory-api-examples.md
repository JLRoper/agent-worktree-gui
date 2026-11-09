# AI factory API examples, verbatim

The working calls from the two POCs on 2026-11-09, in the order they ran. Every path, query string and JSON body below is the recorded one. The two ledgers are the authority:

- `docs/reports/assets/ai-factory-poc/qdrant-calls.json`, 50,532 bytes, SHA-256 `7d735ac4d8cf8d4e6a92d0a44627d53f10b203bb2e1ca79a47ab9cb0b5604221`.
- `docs/reports/assets/ai-factory-poc/n8n-calls.json`, 47,006 bytes, SHA-256 `9bd382efc5d90f2623ea4642e4f3f4925a8397845df583fae3d7d75f11a684a1`.

The two POC reports carry the same calls with commentary: `docs/reports/ai-factory-poc-qdrant-2026-11-09.md` and `docs/reports/ai-factory-poc-n8n-2026-11-09.md`.

Two substitutions are unavoidable and are named where they appear:

- The n8n owner email, owner password and API key are not in this repository. They are `<redacted>` in the ledger. The examples read them from environment variables or from the run's ledger outside the repository.
- The Qdrant POC collection was deleted at the end of its run. The create, upsert, search and read examples are the recorded calls; running them today recreates the collection and writes to Qdrant, which the brief for this page forbids. They are documentation, not a request to replay.

No example below uses a secret value. None of them deletes the n8n workflow or the API key.

## Qdrant

Base URL: `http://127.0.0.1:6333`. No authentication on loopback. Version 1.12.4.

### 1. List collections

```bash
curl -sS http://127.0.0.1:6333/collections
```

Recorded response, HTTP 200, 91 bytes, 39.3 ms:

```json
{"result":{"collections":[{"name":"engineering_standards"}]},"status":"ok","time":0.000009149}
```

### 2. Create the POC collection

```bash
curl -sS -X PUT 'http://127.0.0.1:6333/collections/poc_panel_docs' \
  -H 'Content-Type: application/json' \
  --data-binary '{"vectors":{"size":64,"distance":"Cosine","on_disk":false},"hnsw_config":{"m":8,"ef_construct":64},"optimizers_config":{"default_segment_number":2}}'
```

The body as sent, pretty-printed:

```json
{
  "vectors": {
    "size": 64,
    "distance": "Cosine",
    "on_disk": false
  },
  "hnsw_config": {
    "m": 8,
    "ef_construct": 64
  },
  "optimizers_config": {
    "default_segment_number": 2
  }
}
```

Recorded response, HTTP 200, 48 bytes, 641.5 ms client side, 612.33 ms server side:

```json
{"result":true,"status":"ok","time":0.612325433}
```

### 3. Upsert the 56 points

The full body is 35,454 bytes and is recorded as `calls[2].request.body` in `qdrant-calls.json`; do not retype it. Extract the exact body and pipe it back:

```bash
node -e "const q=require('./docs/reports/assets/ai-factory-poc/qdrant-calls.json');const c=q.calls.find(x=>x.step==='3-upsert');process.stdout.write(JSON.stringify(c.request.body))" > qdrant-upsert.json

curl -sS -X PUT 'http://127.0.0.1:6333/collections/poc_panel_docs/points?wait=true' \
  -H 'Content-Type: application/json' \
  --data-binary @qdrant-upsert.json
```

Shape of the body (first point shown; the remaining 55 are in the asset):

```json
{
  "points": [
    {
      "id": 1,
      "vector": [0.114614, -0.074892, -0.097029, "... 64 components ..."],
      "payload": {
        "source": "docs/reports/step-8-queue-prefix-2026-11-07.md",
        "offset": 0,
        "length": 700,
        "chunk": 0
      }
    },
    "... 55 more points ..."
  ]
}
```

The exact body's SHA-256 is `0b5115e21f289a2bb3bf0fc78c341e585b8dc5da25532c3985117da7482e51b7`.

Recorded response, HTTP 200, 83 bytes, 71.6 ms client side, 50.65 ms server side:

```json
{"result":{"operation_id":0,"status":"completed"},"status":"ok","time":0.050651178}
```

### 4. Read the collection back

```bash
curl -sS http://127.0.0.1:6333/collections/poc_panel_docs
```

Recorded response, HTTP 200, 809 bytes, 5.3 ms client side. The fields that matter here:

```json
{
  "result": {
    "status": "green",
    "optimizer_status": "ok",
    "indexed_vectors_count": 0,
    "points_count": 56,
    "segments_count": 2,
    "config": {
      "params": {
        "vectors": {"size": 64, "distance": "Cosine", "on_disk": false},
        "shard_number": 1,
        "replication_factor": 1,
        "on_disk_payload": true
      },
      "hnsw_config": {"m": 8, "ef_construct": 64, "full_scan_threshold": 10000}
    },
    "payload_schema": {}
  },
  "status": "ok",
  "time": 0.002197504
}
```

`points_count` 56 is the server's count after `wait=true`, not the number the client hoped it sent.

### 5. Filtered search

Query text: `what changed in server.js when the assistant queue prefix moved into routes`.

```bash
curl -sS -X POST 'http://127.0.0.1:6333/collections/poc_panel_docs/points/query' \
  -H 'Content-Type: application/json' \
  --data-binary '{"query":[0,0.208514,0,0,0,0,0,0,0,-0.208514,0.208514,0,0,0,0,0,-0.208514,-0.208514,0.208514,0,0,0,0,0.208514,0,0.208514,0,0.208514,-0.208514,0,0,0,0,0,0,0.208514,-0.208514,0,0,-0.417029,0,-0.208514,0,-0.208514,0,0,0,-0.208514,0.208514,0,0,0,0,0,0,0,-0.208514,0,0,0.208514,-0.208514,0,0,0],"filter":{"must":[{"key":"source","match":{"value":"docs/reports/step-8-queue-prefix-2026-11-07.md"}}]},"limit":3,"with_payload":true,"with_vector":false}'
```

The same body, pretty-printed with the 64-float query vector on one line:

```json
{
  "query": [0,0.208514,0,0,0,0,0,0,0,-0.208514,0.208514,0,0,0,0,0,-0.208514,-0.208514,0.208514,0,0,0,0,0.208514,0,0.208514,0,0.208514,-0.208514,0,0,0,0,0,0,0.208514,-0.208514,0,0,-0.417029,0,-0.208514,0,-0.208514,0,0,0,-0.208514,0.208514,0,0,0,0,0,0,0,-0.208514,0,0,0.208514,-0.208514,0,0,0],
  "filter": {
    "must": [
      {
        "key": "source",
        "match": {
          "value": "docs/reports/step-8-queue-prefix-2026-11-07.md"
        }
      }
    ]
  },
  "limit": 3,
  "with_payload": true,
  "with_vector": false
}
```

Recorded response, HTTP 200, 493 bytes, 60.4 ms client side, 39.09 ms server side:

```json
{
  "result": {
    "points": [
      {"id": 2, "version": 0, "score": 0.39233416, "payload": {"source": "docs/reports/step-8-queue-prefix-2026-11-07.md", "offset": 600, "length": 700, "chunk": 1}},
      {"id": 1, "version": 0, "score": 0.38455826, "payload": {"source": "docs/reports/step-8-queue-prefix-2026-11-07.md", "offset": 0, "length": 700, "chunk": 0}},
      {"id": 8, "version": 0, "score": 0.29143798, "payload": {"source": "docs/reports/step-8-queue-prefix-2026-11-07.md", "offset": 4200, "length": 605, "chunk": 7}}
    ]
  },
  "status": "ok",
  "time": 0.039094618
}
```

### 6. Read one point

```bash
curl -sS http://127.0.0.1:6333/collections/poc_panel_docs/points/2
```

Recorded response, HTTP 200, 670 bytes, 13.0 ms client side:

```json
{
  "result": {
    "id": 2,
    "payload": {"source": "docs/reports/step-8-queue-prefix-2026-11-07.md", "offset": 600, "length": 700, "chunk": 1},
    "vector": ["... 64 components ..."]
  },
  "status": "ok",
  "time": 0.002690844
}
```

### 7. Delete the POC collection

This is the call the POC used for cleanup. The collection is already gone, so it answers 404 today; it is listed to complete the recorded series, not as a cleanup instruction.

```bash
curl -sS -X DELETE 'http://127.0.0.1:6333/collections/poc_panel_docs?timeout=10'
```

Recorded response at the time, HTTP 200, 48 bytes, 88.9 ms client side:

```json
{"result":true,"status":"ok","time":0.062713994}
```

### 8. List collections after cleanup

```bash
curl -sS http://127.0.0.1:6333/collections
```

Recorded response, HTTP 200, 91 bytes, 2.2 ms client side:

```json
{"result":{"collections":[{"name":"engineering_standards"}]},"status":"ok","time":0.000004589}
```

## n8n

Base URL: `http://127.0.0.1:5678`. Version 2.46.6. Two surfaces, two auth models:

- Public API: `/api/v1`, `X-N8N-API-KEY` header. This is the one to build on.
- Internal API: `/rest`, `n8n-auth` session cookie. Editor plumbing, not a contract. `/rest/me` is absent in this build (404).

Set the two variables the examples need:

```bash
export N8N_API_KEY='the raw key from the run ledger'   # not in this repository
```

For the session examples, the owner email and password are also outside this repository. The recorded bodies carry `<redacted>` in both fields.

### 1. Public instance settings, no credential

```bash
curl -sS http://127.0.0.1:5678/rest/settings
```

Recorded response, HTTP 200, 476 bytes, 17.7 ms:

```json
{"data":{"settingsMode":"public","defaultLocale":"en","userManagement":{"authenticationMethod":"email","showSetupOnFirstLoad":false,"smtpSetup":false,"passwordMinLength":8},"sso":{"saml":{"loginEnabled":false},"ldap":{"loginEnabled":false,"loginLabel":""},"oidc":{"loginEnabled":false,"loginUrl":"http://localhost:5678/rest/sso/oidc/login"}},"authCookie":{"secure":false},"previewMode":false,"enterprise":{"saml":false,"ldap":false,"oidc":false},"communityNodesEnabled":true}}
```

### 2. Public API without a key

```bash
curl -sS http://127.0.0.1:5678/api/v1/workflows
```

Recorded response, HTTP 401, 26 bytes, 11.6 ms:

```json
{"message":"Unauthorized"}
```

### 3. Public API with the key

```bash
curl -sS http://127.0.0.1:5678/api/v1/workflows \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Recorded response when no workflow existed, HTTP 200, 29 bytes, 52.2 ms:

```json
{"data":[],"nextCursor":null}
```

### 4. Owner login, session cookie

The recorded request body replaces the owner email and password with `<redacted>`:

```json
{"emailOrLdapLoginId":"<redacted>","password":"<redacted>"}
```

With the values from the run ledger in the environment:

```bash
export N8N_EMAIL='owner email' N8N_PASSWORD='owner password'
node -e "process.stdout.write(JSON.stringify({emailOrLdapLoginId:process.env.N8N_EMAIL,password:process.env.N8N_PASSWORD}))" > n8n-login.json
curl -sS -c n8n-cookies.txt -X POST http://127.0.0.1:5678/rest/login \
  -H 'Content-Type: application/json' \
  --data-binary @n8n-login.json
```

Recorded response, HTTP 200, 4,856 bytes, 207.9 ms. It sets the `n8n-auth` cookie. The same jar answers the editor surface; it is not needed once an API key exists.

### 5. Create the API key

The recorded request body, with the 36 scopes verbatim:

```json
{
  "label": "poc-ai-factory-machine",
  "scopes": [
    "credential:create",
    "credential:delete",
    "credential:list",
    "credential:move",
    "credential:read",
    "credential:update",
    "execution:delete",
    "execution:list",
    "execution:read",
    "project:create",
    "project:delete",
    "project:export",
    "project:list",
    "project:manageMembers",
    "project:update",
    "tag:create",
    "tag:delete",
    "tag:list",
    "tag:read",
    "tag:update",
    "variable:create",
    "variable:delete",
    "variable:list",
    "variable:update",
    "workflow:create",
    "workflow:delete",
    "workflow:export",
    "workflow:import",
    "workflow:list",
    "workflow:move",
    "workflow:read",
    "workflow:update",
    "workflow:activate",
    "workflow:deactivate",
    "execution:retry",
    "execution:stop"
  ],
  "expiresAt": null
}
```

```bash
node -e "const n=require('./docs/reports/assets/ai-factory-poc/n8n-calls.json');const c=n.calls.find(x=>x.step==='7-api-key-create');process.stdout.write(JSON.stringify(c.request.body))" > n8n-key.json

curl -sS -b n8n-cookies.txt -X POST http://127.0.0.1:5678/rest/api-keys \
  -H 'Content-Type: application/json' \
  --data-binary @n8n-key.json
```

The recorded response is HTTP 200, 1,187 bytes, 111.7 ms. It carries the secret twice: `apiKey` masked to its last four characters and `rawApiKey` in full. The raw value is the one a client sends; it is not reproduced here.

### 6. Create the workflow

The recorded body is 2,283 bytes of response, and the request body is the object below. Extract the exact body from the ledger and send it:

```bash
node -e "const n=require('./docs/reports/assets/ai-factory-poc/n8n-calls.json');const c=n.calls.find(x=>x.step==='E-workflow-create');process.stdout.write(JSON.stringify(c.request.body))" > n8n-workflow.json

curl -sS -X POST http://127.0.0.1:5678/api/v1/workflows \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @n8n-workflow.json
```

Body, pretty-printed:

```json
{
  "name": "AI Factory POC - webhook echo",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "poc-ai-factory",
        "responseMode": "responseNode",
        "options": {}
      },
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [
        -300,
        0
      ],
      "webhookId": "poc-ai-factory-webhook"
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const item = $input.first().json;\nconst body = (item && item.body) || {};\nconst items = Array.isArray(body.items) ? body.items : [];\nconst score = Number(body.score || 0);\nconst name = String(body.name || '');\nreturn [{ json: {\n  ok: true,\n  received: { name: name, score: score, itemCount: items.length },\n  computed: { doubledScore: score * 2, nameUpper: name.toUpperCase(), itemsSorted: items.slice().sort() },\n  servedBy: 'n8n-poc-webhook',\n  processedAt: new Date().toISOString()\n} }];"
      },
      "name": "Shape result",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        0,
        0
      ]
    },
    {
      "parameters": {
        "respondWith": "firstIncomingItem",
        "options": {}
      },
      "name": "Respond to Webhook",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [
        300,
        0
      ]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [
          {
            "node": "Shape result",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Shape result": {
      "main": [
        [
          {
            "node": "Respond to Webhook",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  },
  "staticData": null
}
```

Recorded response, HTTP 200, 2,283 bytes, 221.7 ms. The created workflow id is `obtlKZkEdITo7Xtr`, `active` is false, `versionId` is `8cf6a64f-4f0a-4e8a-a57c-0fc7c0df2a5b`, and the workflow landed in the owner's personal project.

### 7. Read the workflow

```bash
curl -sS http://127.0.0.1:5678/api/v1/workflows/obtlKZkEdITo7Xtr \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Recorded response, HTTP 200, 2,283 bytes, 37.9 ms, byte-for-byte the same size as the create response and the same workflow.

### 8. Publish the workflow

```bash
curl -sS -X POST http://127.0.0.1:5678/api/v1/workflows/obtlKZkEdITo7Xtr/publish \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Recorded response, HTTP 200, 3,648 bytes, 656.9 ms. It sets `active: true`, `activeVersionId: 8cf6a64f-4f0a-4e8a-a57c-0fc7c0df2a5b` and `versionCounter: 1`. This is the call that makes the production webhook live.

### 9. Call the webhook

No credential of any kind. The recorded body:

```bash
curl -sS -X POST http://127.0.0.1:5678/webhook/poc-ai-factory \
  -H 'Content-Type: application/json' \
  --data-binary '{"name":"Ada Lovelace","score":21,"items":["beta","alpha","gamma"],"note":"ai factory poc","nested":{"a":1,"b":true}}'
```

Recorded response, HTTP 200, 238 bytes, 848.3 ms:

```json
{"ok":true,"received":{"name":"Ada Lovelace","score":21,"itemCount":3},"computed":{"doubledScore":42,"nameUpper":"ADA LOVELACE","itemsSorted":["alpha","beta","gamma"]},"servedBy":"n8n-poc-webhook","processedAt":"2026-11-09T07:11:18.196Z"}
```

This call creates an execution. The POC ran it once; running it again adds an execution to the same workflow. It does not delete or modify the workflow.

### 10. The method boundary

```bash
curl -sS http://127.0.0.1:5678/webhook/poc-ai-factory
```

Recorded response, HTTP 404, 110 bytes, 29.5 ms:

```json
{"code":404,"message":"This webhook is not registered for GET requests. Did you mean to make a POST request?"}
```

A GET is not a health check for a method-bound webhook.

### 11. Read the execution back

```bash
curl -sS 'http://127.0.0.1:5678/api/v1/executions?workflowId=obtlKZkEdITo7Xtr&includeData=false' \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Recorded response, HTTP 200, 254 bytes, 52.5 ms:

```json
{"data":[{"id":"1","finished":true,"mode":"webhook","retryOf":null,"retrySuccessId":null,"status":"success","startedAt":"2026-11-09T07:11:17.550Z","stoppedAt":"2026-11-09T07:11:18.212Z","workflowId":"obtlKZkEdITo7Xtr","waitTill":null}],"nextCursor":null}
```

`startedAt` to `stoppedAt` is 662 ms, which is n8n's own duration for the execution. The client saw 848.3 ms for the same call, so about 186 ms is outside the execution.

## Replay order

Qdrant: 1, 2, 3, 4, 5, 6, 7, 8. The collection is created once, written once, queried once, read once, deleted once. The POC's own bodies and latencies are in `qdrant-calls.json`.

n8n: 1, 2, 3, 5, 6, 7, 8, 9, 10, 11. Call 4 is only needed to mint the key in call 5; after that the key header is the whole credential. The POC's 19 calls, including the setup and the session-only calls, are in `n8n-calls.json`.

The two reports name the one number this document does not repeat: the number of points the Qdrant collection held (56) and the one execution n8n recorded (1, at 662 ms). Those are the counts to check when replaying.
