# Stage 1: Build React UI
FROM oven/bun:1-alpine AS ui-builder
ARG BUN_CONFIG_REGISTRY
ENV BUN_CONFIG_REGISTRY=${BUN_CONFIG_REGISTRY}
WORKDIR /ui
COPY ui/package.json ui/bun.lock* ./
RUN bun install
COPY ui/ .
RUN bun run build

# Stage 2: Build Go backend
FROM golang:1.24-alpine AS backend-builder
ENV CGO_ENABLED=0
WORKDIR /backend
COPY backend/go.mod backend/go.sum* ./
RUN go mod download 2>/dev/null || true
COPY backend/ .
RUN go build -trimpath -ldflags="-s -w" -o /service

# Stage 3: Final extension image
FROM alpine:3.21
LABEL org.opencontainers.image.title="Agent Memory" \
      org.opencontainers.image.description="Shared offline memory for AI agents via Hindsight. MCP-first, Docker MCP Gateway compatible." \
      org.opencontainers.image.vendor="agent-memory" \
      com.docker.desktop.extension.api.version="0.3.4" \
      com.docker.desktop.extension.icon="/docker.svg"

COPY metadata.json .
COPY docker.svg .
COPY compose.yaml .
COPY --from=ui-builder /ui/dist ui
COPY --from=backend-builder /service /

CMD ["/service", "-socket", "/run/guest-services/agent-memory.sock"]
