# Agent Memory — Docker Desktop Extension

Shared offline memory for AI agents, powered by [Hindsight](https://github.com/vectorize-io/hindsight).

Give every AI agent (Claude, Cursor, VS Code Copilot, custom agents) a persistent, searchable memory that works entirely offline — no cloud required.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Docker Desktop                        │
│                                                           │
│  ┌──────────────┐    ┌──────────────────────────────────┐ │
│  │   React UI   │───▶│   Go Backend (Unix Socket)       │ │
│  │  Settings,   │    │   Config, Secrets, Bank Proxy    │ │
│  │  Banks,      │    └──────────┬───────────────────────┘ │
│  │  Memories    │               │                         │
│  └──────────────┘               ▼                         │
│                     ┌──────────────────────────────────┐  │
│                     │   Hindsight Container             │  │
│                     │   ┌───────────┐                  │  │
│                     │   │ MCP Server│  ┌─────────────┐ │  │
│                     │   │ :8888     │  │ Control Plane│ │  │
│                     │   └───────────┘  │ :9999        │ │  │
│                     │                  └─────────────┘ │  │
│                     └──────────────────────────────────┘  │
│                     ┌──────────────────────────────────┐  │
│                     │   PostgreSQL + pgvector (pg17)    │  │
│                     │   Persistent volume               │  │
│                     └──────────────────────────────────┘  │
└──────────────────────────────────────┬────────────────────┘
                                       │ ports 8888, 9999
                    ┌──────────────────▼──────────────────┐
                    │         AI Agents (MCP Clients)      │
                    │  Claude Code  │ Cursor │ VS Code     │
                    │  Custom Agent │ Docker MCP Gateway    │
                    └─────────────────────────────────────┘
```

Three containers orchestrated by Docker Desktop:
- **api** — Go backend handling config, secrets, and proxying to Hindsight
- **postgres** — pgvector/pgvector:pg17 with persistent volume
- **hindsight** — MCP server + control plane UI

## Features

- **Offline-first**: Core memory operations (retain + recall) work without any LLM
- **MCP-native**: Agents connect via standard HTTP MCP protocol
- **Multi-bank**: Organize memories by project, agent, or topic
- **Persistent**: Memories survive container restarts via Docker volumes
- **Docker MCP Gateway**: Compatible with `docker mcp gateway connect`
- **Optional LLM**: Add Ollama, OpenAI, Anthropic, or any OpenAI-compatible proxy for fact extraction
- **Dual-mode settings**: Basic form or Advanced YAML editor with schema validation
- **Secrets management**: `${secret.NAME}` placeholders with inline editor in the YAML view
- **Monitoring**: Prometheus metrics + optional OpenTelemetry tracing

## Quick Start

### Build & Install

```bash
make install
```

This builds the extension image and installs it into Docker Desktop.

> **Behind a TLS-intercepting proxy?** Pass the registry as a build arg:
> ```bash
> docker build --build-arg BUN_CONFIG_REGISTRY=<your-registry-url> -t pplenkov/agent-memory:latest .
> docker extension install pplenkov/agent-memory:latest
> ```

### Connect an Agent

Once installed, agents can connect to:

```
http://localhost:8888/mcp/{bank_id}/
```

Replace `{bank_id}` with a memory bank name (e.g., `default`, `my-project`).

## Agent Configuration

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json` or `.mcp.json`:

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

Add to `.cursor/mcp.json`:

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

Add to `.vscode/mcp.json`:

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

## Memory Operations

### Retain (Store)

Without an LLM, use `verbatim` or `chunks` strategy:

```json
{
  "strategy": "verbatim",
  "content": "The API rate limit is 100 requests per minute per user."
}
```

- **verbatim** — stores text exactly as provided; best for short, specific facts
- **chunks** — splits longer text into overlapping segments for better search coverage
- **extract** (requires LLM) — uses the model to identify discrete facts and entities

### Recall (Search)

Recall uses local embeddings — no LLM needed:

```json
{
  "query": "rate limit",
  "n": 5
}
```

### Reflect (Reason)

Reflect uses an LLM to reason over stored memories with a disposition (personality):

```json
{
  "query": "What patterns do you see in our API usage?"
}
```

## Configuration

### Settings UI

Open the extension in Docker Desktop and go to the **Settings** tab. Two modes:

| Mode | Use case |
|------|----------|
| **Basic** | Point-and-click: pick an LLM provider, enter model + API key, toggle observations |
| **Advanced (YAML)** | Full Hindsight config as YAML with Monaco editor, schema validation, autocomplete |

The YAML hierarchy maps directly to `HINDSIGHT_API_*` environment variables:

```yaml
hindsight:
  api:
    llm:
      provider: openai      # → HINDSIGHT_API_LLM_PROVIDER
      model: gpt-4o-mini    # → HINDSIGHT_API_LLM_MODEL
      api_key: ${secret.LLM_API_KEY}
```

### Secrets Management

Sensitive values (API keys, tokens) use `${secret.NAME}` placeholders in the YAML config. Secrets are stored as files on a private Docker volume and resolved into the env file at save time.

**In the YAML editor**, secret placeholders get:
- Green underline when set, red wavy underline when missing
- Hover tooltip showing status
- Click to open an inline popup with a password input, visibility toggle, and Save/Cancel

**In the sidebar Secrets card**, only placeholders actually present in your config are shown.

### Per-Operation LLM

Use different models for different operations:

```yaml
hindsight:
  api:
    llm:
      provider: openai
      model: gpt-4o-mini
      api_key: ${secret.LLM_API_KEY}
    retain:
      llm:
        provider: groq
        model: openai/gpt-oss-20b
        api_key: ${secret.GROQ_API_KEY}
    reflect:
      llm:
        provider: groq
        model: openai/gpt-oss-120b
        api_key: ${secret.GROQ_API_KEY}
```

### LLM Providers

The extension works fully offline. LLM is only needed for:
- `extract` retain strategy (fact extraction)
- `reflect` operation (memory consolidation)
- `observations` (automatic fact extraction from agent interactions)

| Provider | Value | Notes |
|----------|-------|-------|
| None | `none` | Default, offline mode |
| Ollama | `ollama` | Local, set base_url to `http://host.docker.internal:11434` |
| LM Studio | `lmstudio` | Local, set base_url to `http://host.docker.internal:1234` |
| OpenAI | `openai` | Requires API key; also works with OpenAI-compatible proxies (LiteLLM, etc.) |
| Anthropic | `anthropic` | Requires API key |
| Groq | `groq` | Fast inference, requires API key |
| Google Gemini | `gemini` | Requires API key |

> **Tip:** Use `host.docker.internal` instead of `localhost` for services running on the host.

### Database

By default, a dedicated PostgreSQL 17 container with pgvector runs alongside Hindsight. Data persists on the `agent-memory-postgres-data` Docker volume.

To use your own PostgreSQL (14+ with pgvector), toggle "Use custom PostgreSQL" in Settings and provide the connection string.

### Monitoring

**Prometheus metrics** are always available at `http://localhost:8888/metrics`.

**OpenTelemetry tracing** is opt-in via the Settings UI. Configure:
- OTLP endpoint (e.g., `http://host.docker.internal:4318` for Grafana LGTM)
- Optional headers, service name, deployment environment

Pre-built Grafana dashboards (Operations, LLM Metrics, API Service) are available from the [Hindsight repo](https://github.com/vectorize-io/hindsight).

## API Reference

### Go Backend (Unix socket)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (Hindsight status) |
| `GET` | `/status` | Full status with bank counts |
| `GET` | `/banks` | List all memory banks |
| `POST` | `/banks` | Create a memory bank |
| `GET` | `/banks/{id}` | Get bank details |
| `POST` | `/retain` | Store a memory |
| `POST` | `/recall` | Search memories |
| `GET` | `/config` | Get current basic config |
| `POST` | `/config` | Save basic config |
| `GET` | `/config/yaml` | Get YAML config |
| `POST` | `/config/yaml` | Save YAML config |
| `POST` | `/apply-config` | Apply config to all banks |
| `GET` | `/secrets` | List secrets referenced in YAML |
| `POST` | `/secrets` | Bulk upsert secrets |
| `PUT` | `/secrets/{name}` | Set single secret |
| `DELETE` | `/secrets/{name}` | Delete single secret |

### Hindsight MCP (direct)

Agents connect directly to `http://localhost:8888/mcp/{bank_id}/`.

### Hindsight REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/default/banks` | List banks (response: `{"banks": [...]}`) |
| `PUT` | `/v1/default/banks/{id}` | Create/update bank |
| `POST` | `/v1/default/banks/{id}/memories` | Retain |
| `POST` | `/v1/default/banks/{id}/memories/recall` | Recall |

## Development

### Dev Mode (live UI reload)

```bash
make dev
```

### Debug

```bash
make debug
```

### Validate Extension

```bash
make validate
```

### Rebuild & Update

```bash
make update
```

### Remove

```bash
make remove
```

## Why Hindsight?

| Option | Pros | Cons |
|--------|------|------|
| **Hindsight** | MCP-native, local embeddings, no LLM needed, temporal+graph retrieval | Newer project |
| mem0 | Popular, multi-provider | Requires external Postgres + Qdrant |
| Zep | Good MCP support | Requires multiple containers |
| ChromaDB | Simple embedding store | No MCP, not agent-oriented |
| Custom (pgvector) | Full control | Significant development effort |

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 8888 | Hindsight API + MCP | Agent connections, REST API, Prometheus metrics |
| 9999 | Hindsight Control Plane | Built-in browser interface |

## License

MIT
