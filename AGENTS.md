# Agent Memory — Project Rules

## Build

- **Docker build may require a custom npm registry**: If your network intercepts TLS, pass `BUN_CONFIG_REGISTRY=<your-registry-url>` as a build arg to avoid `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` inside the Docker VM.
  ```
  docker build --build-arg BUN_CONFIG_REGISTRY=<your-registry-url> -t pplenkov/agent-memory:latest .
  ```
- **No local Go or Node toolchain needed** — everything builds inside Docker multi-stage (bun for UI, golang for backend).

## Architecture Constraints

### Docker Desktop Extension VM Services
- The `api`, `postgres`, and `hindsight` services are **separate containers** managed by Docker Desktop's internal compose. They share a network but NOT a PID namespace.
- You **cannot** `pkill`, `kill`, or signal processes across containers. Don't add `os/exec` calls targeting processes in another service.
- The Docker socket is **not mounted** into VM service containers. You cannot use the Docker API from within the backend.
- To restart services, the user must **disable and re-enable the extension** in Docker Desktop, or run `docker extension update --force pplenkov/agent-memory:latest`.
- The `api` container communicates with `hindsight` only via HTTP (ports 8888/9999).

### Database
- **PostgreSQL runs as a separate `pgvector/pgvector:pg17` container** — NOT the embedded pg0 inside Hindsight.
- Data is on the `agent-memory-postgres-data` volume at `/var/lib/postgresql/data`.
- Hindsight connects via `HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@postgres:5432/hindsight`.
- Users can override the database URL in Settings to point to their own external PostgreSQL (requires pgvector extension).
- The `hindsight` service uses `depends_on: postgres: condition: service_healthy` to wait for Postgres readiness before starting.
- **Do NOT use pg0 (Hindsight's embedded Postgres)** — it has caused data loss in Docker Desktop Extension context (see: https://github.com/vectorize-io/hindsight/issues/675).

### Config Flow
- Config is saved to `/data/config.json` and `/data/hindsight.env` on the `agent-memory-config` volume.
- The `hindsight.env` file is **only sourced at container startup** by the entrypoint wrapper. Runtime changes require an extension restart.
- When editing config via Docker volumes from Git Bash on Windows, paths get mangled. Use `//data/` (double slash) to prevent Git Bash from interpreting `/data` as a Windows path.

## Hindsight API

- API version: **v1** — all routes use `/v1/default/banks/...` (not `/api/v1/`).
- Banks list response is wrapped: `{"banks": [...]}` — must unwrap before returning to UI.
- Bank creation uses `PUT /v1/default/banks/{bank_id}` (not POST).
- Retain endpoint: `POST /v1/default/banks/{bank_id}/memories`
- Recall endpoint: `POST /v1/default/banks/{bank_id}/memories/recall`

## LLM Configuration

- **LiteLLM proxy** runs as a separate DD extension at `http://host.docker.internal:4000`.
- LiteLLM config is on Docker volume `litellm-ext-config` at `/data/config.yaml`. Secrets at `/data/secrets/{master_key,api_key,base_url}`.
- **Bedrock-backed Claude models do NOT support `response_format: json_object`** — the upstream returns 422. Use OpenAI-native models or Gemini models instead.
- **Do NOT use reasoning models (gpt-5-mini, gpt-5_4) for Hindsight.** They spend completion tokens on internal chain-of-thought and return empty content with small `max_tokens`. Use `gpt-4o-mini` (non-reasoning) instead.
- Current working model for Hindsight: `gpt-4o-mini` via `kilocode:12` backend.

## Verification

```bash
# Build the extension (add --build-arg BUN_CONFIG_REGISTRY=<url> if needed)
docker build -t pplenkov/agent-memory:latest .

# Update (restart) the extension
docker extension update pplenkov/agent-memory:latest --force

# Check Hindsight health
curl -s http://localhost:8888/health

# Test retain + recall end-to-end
curl -s http://localhost:8888/mcp/default/ -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"retain","arguments":{"content":"test fact"}},"id":1}'
sleep 5
curl -s http://localhost:8888/mcp/default/ -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"recall","arguments":{"query":"test"}},"id":2}'
```

## Monitoring

- **Prometheus metrics** are always available at `http://localhost:8888/metrics` — no config needed.
- **OpenTelemetry tracing** is opt-in via the Settings tab in the extension UI.
- Config env vars written to `hindsight.env`: `HINDSIGHT_API_OTEL_TRACES_ENABLED`, `HINDSIGHT_API_OTEL_EXPORTER_OTLP_ENDPOINT`, `HINDSIGHT_API_OTEL_EXPORTER_OTLP_HEADERS`, `HINDSIGHT_API_OTEL_SERVICE_NAME`, `HINDSIGHT_API_OTEL_DEPLOYMENT_ENVIRONMENT`.
- For a local Grafana LGTM stack running as a Docker Desktop extension, use `http://host.docker.internal:4318` as the OTLP endpoint (not `localhost`).
- Pre-built Grafana dashboards (Operations, LLM Metrics, API Service) are available from the Hindsight repo.

## Security Rules

- **NEVER commit internal/corporate URLs, hostnames, or registry paths** to this repository. It is public on GitHub. Use placeholders like `<your-registry-url>` instead.
- Committer email addresses are acceptable (they are already publicly visible in git metadata).
- When in doubt, use environment variables or local config files (gitignored) for any organization-specific values.
