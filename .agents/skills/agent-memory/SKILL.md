---
name: agent-memory
description: >
  Install and use the Agent Memory Docker Desktop Extension for persistent,
  offline memory across AI agents. Covers installation, configuration,
  retain/recall/reflect operations via HTTP API, secrets management, and
  monitoring. Use when the user wants shared agent memory or asks about
  Hindsight, agent-memory, or persistent recall.
---

# Agent Memory — Docker Desktop Extension Skill

Give every AI agent a persistent, searchable memory powered by
[Hindsight](https://github.com/vectorize-io/hindsight). Runs entirely
offline inside Docker Desktop — no cloud required.

## When to Use This Skill

- User asks for persistent / shared memory across agents or sessions
- User mentions Hindsight, agent-memory, or recall/retain
- User wants to store and search facts, context, or observations
- User needs to install, configure, or troubleshoot the extension
- You want to use memory yourself (retain learnings, recall context)

---

## 1. Prerequisites

- Docker Desktop 4.34+ with Extensions enabled
- `docker` CLI available in the shell
- (Optional) An LLM provider for fact extraction: Ollama, OpenAI, Anthropic,
  Groq, Gemini, or any OpenAI-compatible proxy

---

## 2. Install the Extension

### Option A: From source

```bash
git clone https://github.com/pplenkov/hindsight-docker-desktop-extension.git
cd hindsight-docker-desktop-extension
make install            # or: docker build -t pplenkov/agent-memory:latest . && docker extension install pplenkov/agent-memory:latest
```

> Behind a TLS-intercepting proxy? Pass the registry:
> ```bash
> docker build --build-arg BUN_CONFIG_REGISTRY=<your-registry-url> -t pplenkov/agent-memory:latest .
> ```

### Option B: Pre-built image (when published)

```bash
docker extension install pplenkov/agent-memory:latest
```

### Verify

```bash
# Wait ~15 seconds for all three containers to start, then:
curl -s http://localhost:8888/health
# → {"status":"healthy","database":"connected"}
```

---

## 3. Architecture

Three containers managed by Docker Desktop:

| Container | Image | Purpose |
|-----------|-------|---------|
| **api** | `pplenkov/agent-memory` | Go backend — config, secrets, bank proxy |
| **postgres** | `pgvector/pgvector:pg17` | Vector-capable database, persistent volume |
| **hindsight** | `ghcr.io/vectorize-io/hindsight:latest` | MCP server (:8888), control plane UI (:9999) |

Ports exposed to the host:
- **8888** — Hindsight API + MCP endpoint + Prometheus metrics
- **9999** — Hindsight web UI (control plane)

---

## 4. Using Memory (API)

All operations use the Hindsight HTTP API at `http://localhost:8888`.

### 4.1 Retain (store a memory)

```bash
curl -s http://localhost:8888/mcp/default/ -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "retain",
      "arguments": {
        "content": "The deploy pipeline requires approval from two reviewers."
      }
    },
    "id": 1
  }'
```

Strategies (pass in arguments):
- **verbatim** — stores text as-is (no LLM needed)
- **chunks** — splits into overlapping segments (no LLM needed)
- **extract** — LLM extracts discrete facts + entities (needs LLM)

Default strategy depends on whether an LLM is configured.

### 4.2 Recall (search memories)

```bash
curl -s http://localhost:8888/mcp/default/ -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "recall",
      "arguments": {
        "query": "deploy approval",
        "n": 5
      }
    },
    "id": 2
  }'
```

Recall uses **local embeddings** — no LLM needed. Returns ranked results
with semantic, BM25, graph, and temporal retrieval.

### 4.3 Reflect (reason over memories)

```bash
curl -s http://localhost:8888/mcp/default/ -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "reflect",
      "arguments": {
        "query": "What patterns exist in our deployment process?"
      }
    },
    "id": 3
  }'
```

Reflect requires an LLM. It reasons over stored memories using a
configurable disposition (personality traits like skepticism, empathy).

### 4.4 Memory banks

Memories are organized into **banks**. Use different banks per project,
agent, or topic:

```
http://localhost:8888/mcp/{bank_id}/
```

Banks are created automatically on first use. To list banks:

```bash
curl -s http://localhost:8888/v1/default/banks
# → {"banks": [...]}
```

### 4.5 REST API (non-MCP)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/default/banks` | List banks |
| `PUT` | `/v1/default/banks/{id}` | Create/update bank |
| `POST` | `/v1/default/banks/{id}/memories` | Retain (requires `items` array) |
| `POST` | `/v1/default/banks/{id}/memories/recall` | Recall |
| `GET` | `/metrics` | Prometheus metrics |

---

## 5. Connecting Agents

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "agent-memory": {
      "url": "http://localhost:8888/mcp/default/"
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "agent-memory": {
      "type": "http",
      "url": "http://localhost:8888/mcp/default/"
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "agent-memory": {
      "type": "http",
      "url": "http://localhost:8888/mcp/default/"
    }
  }
}
```

### Docker MCP Gateway

```bash
docker mcp gateway connect agent-memory http://localhost:8888/mcp/default/
```

---

## 6. Configuration

### Via the Extension UI

Open Docker Desktop → Extensions → Agent Memory → Settings tab.

- **Basic mode** — pick LLM provider, enter model + API key, toggle observations
- **Advanced mode** — Monaco YAML editor with schema validation, autocomplete,
  and inline secret management

### Via YAML (programmatic)

The Go backend exposes config endpoints on its Unix socket:

```bash
# Read current YAML
GET /config/yaml → {"yaml": "hindsight:\n  api:\n  ..."}

# Write YAML
POST /config/yaml  (body: raw YAML text)

# Apply config to all existing banks
POST /apply-config
```

### LLM setup

YAML path structure (maps to `HINDSIGHT_API_*` env vars):

```yaml
hindsight:
  api:
    llm:
      provider: openai                  # openai, ollama, anthropic, groq, gemini
      model: gpt-4o-mini
      api_key: ${secret.LLM_API_KEY}    # resolved from secret store
      base_url: http://host.docker.internal:4000  # for proxies
```

> Use `host.docker.internal` instead of `localhost` for host services.

### Secrets

Sensitive values use `${secret.NAME}` placeholders:

```bash
# Set a secret
curl -s --unix-socket /run/guest-services/agent-memory.sock \
  http://d/secrets -X POST -H "Content-Type: application/json" \
  -d '{"secrets": {"LLM_API_KEY": "sk-..."}}'

# List secrets referenced in YAML
curl -s --unix-socket /run/guest-services/agent-memory.sock http://d/secrets
```

---

## 7. Monitoring

- **Prometheus metrics**: always at `http://localhost:8888/metrics`
- **OpenTelemetry tracing**: opt-in via Settings
  - OTLP endpoint: e.g. `http://host.docker.internal:4318` for Grafana LGTM
  - Pre-built Grafana dashboards available from the Hindsight repo

---

## 8. Troubleshooting

### Health check fails

```bash
# Check if all three containers are running
docker compose -p pplenkov_agent-memory-desktop-extension ps

# Check Hindsight logs
docker compose -p pplenkov_agent-memory-desktop-extension logs hindsight

# Restart the extension
docker extension update pplenkov/agent-memory:latest --force
```

### LLM not working

- Verify the model is non-reasoning (`gpt-4o-mini`, not `gpt-5-mini`)
- Bedrock-backed Claude does NOT support `response_format: json_object`
- Check the API key is set: `GET /secrets` should show `"exists": true`
- After changing config, click "Save & Apply" or restart the extension

### Database issues

- Data persists on the `agent-memory-postgres-data` Docker volume
- To reset: `docker volume rm agent-memory-postgres-data` then restart
- Custom PostgreSQL needs pgvector extension: `CREATE EXTENSION vector`

---

## 9. Best Practices for Agents

1. **Use `verbatim` strategy** for short, precise facts you want stored exactly
2. **Use `chunks` strategy** for longer documents (meeting notes, specs)
3. **Use `extract` strategy** (with LLM) when you want automatic fact/entity extraction
4. **Use separate banks** per project or context to avoid cross-contamination
5. **Recall before acting** — check if relevant context already exists
6. **Retain learnings** — after completing a task, store key decisions and outcomes
7. **Use `document_id`** for conversation evolution (same ID = upsert/update)
