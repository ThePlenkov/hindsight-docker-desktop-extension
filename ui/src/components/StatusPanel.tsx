import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Typography,
  Paper,
  Collapse,
  IconButton,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import StorageIcon from "@mui/icons-material/Storage";
import HubIcon from "@mui/icons-material/Hub";
import MemoryIcon from "@mui/icons-material/Memory";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import RefreshIcon from "@mui/icons-material/Refresh";

interface StatusPanelProps {
  ddClient: any;
}

interface HealthStatus {
  status: string;
  hindsight: boolean;
  message?: string;
  last_error?: string;
  hindsight_url?: string;
  details?: any;
  code?: number;
  body?: string;
}

interface AppStatus {
  hindsight_ready: boolean;
  bank_count: number;
  mcp_endpoint: string;
  api_endpoint: string;
  ui_endpoint: string;
  hindsight_url?: string;
  error?: string;
}

export default function StatusPanel({ ddClient }: StatusPanelProps) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const fetchData = async () => {
    try {
      const healthRes = await ddClient.extension.vm?.service?.get("/health");
      setHealth(healthRes);
    } catch (e: any) {
      setHealth({
        status: "error",
        hindsight: false,
        message: "Cannot reach backend service",
        last_error: e?.message || String(e),
      });
    }
    try {
      const statusRes = await ddClient.extension.vm?.service?.get("/status");
      setStatus(statusRes);
    } catch {
      // Backend may not be ready
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress />
        <Typography sx={{ ml: 2 }}>Connecting to Hindsight...</Typography>
      </Box>
    );
  }

  const isRunning = health?.hindsight === true;

  const statusLabel = health?.status ?? "unknown";
  const statusColor: "success" | "warning" | "error" = isRunning
    ? "success"
    : health?.status === "starting"
    ? "warning"
    : "error";

  const statusDescription = isRunning
    ? `Connected to ${health?.hindsight_url ?? "Hindsight"}`
    : health?.status === "starting"
    ? health?.message || "Hindsight is initializing..."
    : health?.status === "error"
    ? health?.message || "Cannot reach backend service"
    : health?.status === "unhealthy"
    ? `Hindsight returned HTTP ${health?.code ?? "error"}`
    : "Unknown state";

  return (
    <Box>
      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <StorageIcon color="primary" />
                <Typography variant="h6">Hindsight Engine</Typography>
                <IconButton size="small" onClick={fetchData} sx={{ ml: "auto" }}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Box>
              <Chip
                icon={
                  isRunning ? (
                    <CheckCircleIcon />
                  ) : health?.status === "starting" ? (
                    <HourglassEmptyIcon />
                  ) : (
                    <ErrorIcon />
                  )
                }
                label={statusLabel}
                color={statusColor}
                sx={{ mt: 1 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {statusDescription}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <MemoryIcon color="primary" />
                <Typography variant="h6">Memory Banks</Typography>
              </Box>
              <Typography variant="h3" color="primary">
                {status?.bank_count ?? 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <HubIcon color="primary" />
                <Typography variant="h6">MCP Endpoint</Typography>
              </Box>
              <Typography
                variant="body2"
                fontFamily="monospace"
                sx={{ wordBreak: "break-all" }}
              >
                {status?.mcp_endpoint ?? "http://localhost:8888/mcp/{bank_id}/"}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {!isRunning && (
        <Alert
          severity={health?.status === "starting" ? "info" : "warning"}
          sx={{ mt: 2 }}
          action={
            <IconButton size="small" onClick={() => setDetailsOpen(!detailsOpen)}>
              {detailsOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          }
        >
          {health?.status === "starting" ? (
            <>Hindsight is starting up. The embedded Postgres database takes 10-15 seconds to initialize on first launch.</>
          ) : health?.status === "error" ? (
            <>Cannot reach the backend service. The extension VM may still be starting.</>
          ) : (
            <>Hindsight is not healthy. Check the details below for more information.</>
          )}
        </Alert>
      )}

      {!isRunning && (
        <Collapse in={detailsOpen}>
          <Paper variant="outlined" sx={{ p: 2, mt: 1, bgcolor: "background.default" }}>
            <Typography variant="subtitle2" gutterBottom>
              Diagnostics
            </Typography>
            <Typography component="pre" variant="body2" fontFamily="monospace" fontSize={12} sx={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {JSON.stringify(
                {
                  health_status: health?.status,
                  hindsight_reachable: health?.hindsight,
                  hindsight_url: health?.hindsight_url,
                  message: health?.message,
                  last_error: health?.last_error,
                  http_code: health?.code,
                  response_body: health?.body,
                  status_error: status?.error,
                  status_hindsight_url: status?.hindsight_url,
                },
                null,
                2
              )}
            </Typography>
          </Paper>
        </Collapse>
      )}

      <Paper sx={{ p: 3, mt: 3 }}>
        <Typography variant="h6" gutterBottom>
          Connect Your Agents
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Add the following MCP server configuration to your AI agent:
        </Typography>

        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Claude Desktop / Claude Code (claude_desktop_config.json):
          </Typography>
          <Paper variant="outlined" sx={{ p: 2, bgcolor: "background.default" }}>
            <Typography component="pre" variant="body2" fontFamily="monospace" fontSize={12}>
              {JSON.stringify(
                {
                  mcpServers: {
                    "agent-memory": {
                      url: "http://localhost:8888/mcp/default/",
                    },
                  },
                },
                null,
                2
              )}
            </Typography>
          </Paper>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Docker MCP Gateway:
          </Typography>
          <Paper variant="outlined" sx={{ p: 2, bgcolor: "background.default" }}>
            <Typography component="pre" variant="body2" fontFamily="monospace" fontSize={12}>
              {`docker mcp gateway connect agent-memory http://localhost:8888/mcp/default/`}
            </Typography>
          </Paper>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Cursor / VS Code (mcp.json):
          </Typography>
          <Paper variant="outlined" sx={{ p: 2, bgcolor: "background.default" }}>
            <Typography component="pre" variant="body2" fontFamily="monospace" fontSize={12}>
              {JSON.stringify(
                {
                  servers: {
                    "agent-memory": {
                      type: "http",
                      url: "http://localhost:8888/mcp/default/",
                    },
                  },
                },
                null,
                2
              )}
            </Typography>
          </Paper>
        </Box>
      </Paper>
    </Box>
  );
}
