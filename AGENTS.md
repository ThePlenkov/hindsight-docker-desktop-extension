# Agent Memory — Project Rules

## Build

- **Docker build requires corporate registry**: Pass `BUN_CONFIG_REGISTRY=<your-registry-url>` as a build arg. Without it, bun install fails with `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` inside the Docker VM.
  ```
  docker build --build-arg BUN_CONFIG_REGISTRY=<your-registry-url> -t pplenkov/agent-memory:latest .
  ```
- **No local Go or Node toolchain needed** — everything builds inside Docker multi-stage (bun for UI, golang for backend).

## Architecture Constraints

### Docker Desktop Extension VM Services
- The `api` and `hindsight` services are **separate containers** managed by Docker Desktop's internal compose. They share a network but NOT a PID namespace.
- You **cannot** `pkill`, `kill`, or signal processes across containers. Don't add `os/exec` calls targeting processes in another service.
- The Docker socket is **not mounted** into VM service containers. You cannot use the Docker API from within the backend.
- To restart services, the user must **disable and re-enable the extension** in Docker Desktop, or run `docker extension update --force pplenkov/agent-memory:latest`.
- The `api` container communicates with `hindsight` only via HTTP (ports 8888/9999).

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
- LiteLLM config is on Docker volume `pplenkov_litellm-dd-ext-desktop-extension_litellm-config` at `/data/config.yaml`.
- **Bedrock-backed Claude models do NOT support `response_format: json_object`** — the upstream returns 422. Use OpenAI-native models (e.g., `gpt-5-mini`) or Gemini models instead.
- LiteLLM's `additional_drop_params` can't selectively drop `json_object` while keeping `json_schema`. Switching models is the correct fix.
- Current working model: `gpt-5-mini` via `kilocode:12` backend.

## Verification

```bash
# Build the extension
docker build --build-arg BUN_CONFIG_REGISTRY=<your-registry-url> -t pplenkov/agent-memory:latest .

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
