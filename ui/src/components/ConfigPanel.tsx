import { useEffect, useState, useCallback, useRef } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Collapse,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import SaveIcon from "@mui/icons-material/Save";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import StorageIcon from "@mui/icons-material/Storage";
import CodeIcon from "@mui/icons-material/Code";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";

// ── Monaco + YAML language service ──────────────────────────────────
// Use the ESM API-only entrypoint — avoids bundling all built-in
// language workers (TypeScript, CSS, HTML, JSON) that we don't need.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { configureMonacoYaml } from "monaco-yaml";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import YamlWorker from "monaco-yaml/yaml.worker?worker";
import hindsightSchema from "../hindsight-schema.json";
import { setupMonacoSecrets, MonacoSecretsHandle } from "./monacoSecrets";

// Worker setup — must happen before any Monaco editor is created.
window.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case "editorWorkerService":
        return new EditorWorker();
      case "yaml":
        return new YamlWorker();
      default:
        // Return the editor worker as fallback instead of throwing.
        // With the ESM API-only import, no other workers should be
        // requested, but this is safer than crashing.
        return new EditorWorker();
    }
  },
};

// Configure YAML language service with Hindsight schema
configureMonacoYaml(monaco, {
  validate: true,
  completion: true,
  hover: true,
  format: true,
  schemas: [
    {
      uri: "https://hindsight.vectorize.io/developer/configuration",
      fileMatch: ["**/hindsight.yaml"],
      schema: hindsightSchema as any,
    },
  ],
});

// Fake file URI so monaco-yaml matches the schema
const MODEL_URI = monaco.Uri.parse("file:///hindsight.yaml");

interface ConfigPanelProps {
  ddClient: any;
}

interface Config {
  llm_provider: string;
  llm_model: string;
  llm_base_url: string;
  llm_max_concurrent: string;
  enable_observations: string;
  llm_api_key?: string;
  // Database
  database_url?: string;
  // Monitoring / OpenTelemetry
  otel_traces_enabled: string;
  otel_endpoint: string;
  otel_headers: string;
  otel_service_name: string;
  otel_environment: string;
}

interface SecretInfo {
  name: string;
  exists: boolean;
}

const LLM_PROVIDERS = [
  { value: "none", label: "None (offline mode)" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "lmstudio", label: "LM Studio (local)" },
  { value: "openai", label: "OpenAI / OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "groq", label: "Groq" },
  { value: "gemini", label: "Google Gemini" },
  { value: "mock", label: "Mock (testing)" },
];


export default function ConfigPanel({ ddClient }: ConfigPanelProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // ── Mode toggle: 0 = Basic, 1 = Advanced YAML ──
  const [mode, setMode] = useState(0);

  // ── Basic mode state ──
  const [config, setConfig] = useState<Config>({
    llm_provider: "none",
    llm_model: "",
    llm_base_url: "",
    llm_max_concurrent: "1",
    enable_observations: "false",
    otel_traces_enabled: "false",
    otel_endpoint: "",
    otel_headers: "",
    otel_service_name: "",
    otel_environment: "",
  });
  const [apiKey, setApiKey] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [useCustomDb, setUseCustomDb] = useState(false);

  // ── YAML mode state ──
  const [yamlLoaded, setYamlLoaded] = useState(false);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const secretsHandleRef = useRef<MonacoSecretsHandle | null>(null);

  // ── Shared state ──
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  // ── Secrets state ──
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = useState(false);
  const [secretsSaved, setSecretsSaved] = useState(false);
  const [secretsError, setSecretsError] = useState("");

  // Fetch secrets list
  const fetchSecrets = useCallback(async () => {
    try {
      const res = await ddClient.extension.vm?.service?.get("/secrets");
      if (res?.secrets) {
        setSecrets(res.secrets);
      }
    } catch {
      // Backend may not be ready
    }
  }, [ddClient]);

  // Fetch basic config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await ddClient.extension.vm?.service?.get("/config");
        if (res) {
          setConfig(res);
        }
      } catch {
        // Backend may not be ready
      }
    };
    fetchConfig();
    fetchSecrets();
  }, []);

  // Get or create the Monaco model for the YAML file
  const getModel = useCallback(() => {
    const existing = monaco.editor.getModel(MODEL_URI);
    if (existing) {
      modelRef.current = existing;
      return existing;
    }
    const m = monaco.editor.createModel("", "yaml", MODEL_URI);
    modelRef.current = m;
    return m;
  }, []);

  // Fetch YAML when switching to advanced mode
  const fetchYAML = useCallback(async () => {
    try {
      const res = await ddClient.extension.vm?.service?.get("/config/yaml");
      const text = res?.yaml ?? (typeof res === "string" ? res : "");
      const model = getModel();
      model.setValue(text);
      setYamlLoaded(true);
    } catch {
      const model = getModel();
      model.setValue("# Failed to load YAML config. Save from Basic mode first.");
      setYamlLoaded(true);
    }
  }, [ddClient, getModel]);

  // Create/destroy the Monaco editor when the YAML tab mounts/unmounts
  useEffect(() => {
    if (mode !== 1 || !editorContainerRef.current) return;

    const model = getModel();

    // Create the Monaco editor instance (raw, no @monaco-editor/react)
    const editor = monaco.editor.create(editorContainerRef.current, {
      model,
      theme: isDark ? "vs-dark" : "light",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      padding: { top: 8 },
      quickSuggestions: {
        other: true,
        comments: false,
        strings: true,
      },
      suggestOnTriggerCharacters: true,
    });
    editorRef.current = editor;

    // Set up secret placeholder decorations, hover, and click-to-edit widget
    const secretsHandle = setupMonacoSecrets(editor, secrets, async (name, value) => {
      try {
        await ddClient.extension.vm?.service?.post("/secrets", {
          secrets: { [name]: value },
        });
        await fetchSecrets(); // triggers updateSecrets via the effect below
        return true;
      } catch {
        return false;
      }
    });
    secretsHandleRef.current = secretsHandle;

    return () => {
      secretsHandle.dispose();
      secretsHandleRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
  }, [mode, yamlLoaded, getModel, isDark]);

  // Sync Monaco theme with MUI dark/light mode
  useEffect(() => {
    monaco.editor.setTheme(isDark ? "vs-dark" : "light");
  }, [isDark]);

  // Push secret status updates to Monaco decorations
  useEffect(() => {
    secretsHandleRef.current?.updateSecrets(secrets);
  }, [secrets]);

  // Fetch basic config when switching back to basic mode
  const fetchBasicConfig = useCallback(async () => {
    try {
      const res = await ddClient.extension.vm?.service?.get("/config");
      if (res) {
        setConfig(res);
      }
    } catch {
      // ignore
    }
  }, [ddClient]);

  const handleModeChange = (_: React.SyntheticEvent, newMode: number) => {
    setMode(newMode);
    setSaved(false);
    setSaveError("");
    setSaveStatus("");
    if (newMode === 1) {
      fetchYAML();
    } else {
      fetchBasicConfig();
    }
    fetchSecrets();
  };

  // Apply config to all existing banks
  const applyConfig = useCallback(async (): Promise<{ applied: number; note?: string; errors?: string[] }> => {
    setSaveStatus("Applying configuration to Hindsight...");
    const res = await ddClient.extension.vm?.service?.post("/apply-config");
    return {
      applied: res?.bank_count ?? 0,
      note: res?.note,
      errors: res?.errors,
    };
  }, [ddClient]);

  // Save secrets (from the Secrets card)
  const handleSaveSecrets = useCallback(async () => {
    const nonEmpty = Object.fromEntries(
      Object.entries(secretValues).filter(([, v]) => v.trim())
    );
    if (Object.keys(nonEmpty).length === 0) return;

    setSavingSecrets(true);
    setSecretsSaved(false);
    setSecretsError("");
    try {
      const res = await ddClient.extension.vm?.service?.post("/secrets", { secrets: nonEmpty });
      if (res?.errors?.length) {
        setSecretsError("Some secrets failed: " + res.errors.join("; "));
      } else {
        setSecretsSaved(true);
        setSecretValues({});
        setTimeout(() => setSecretsSaved(false), 5000);
      }
      await fetchSecrets();
    } catch (e: any) {
      setSecretsError(e?.message || "Failed to save secrets");
    }
    setSavingSecrets(false);
  }, [ddClient, secretValues, fetchSecrets]);

  // Save from Basic mode
  const handleSaveBasic = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    setSaveStatus("Saving configuration...");
    try {
      // If user entered an API key, store it as a secret first
      let apiKeyValue: string | undefined;
      if (apiKey) {
        await ddClient.extension.vm?.service?.post("/secrets", {
          secrets: { LLM_API_KEY: apiKey },
        });
        apiKeyValue = "${secret.LLM_API_KEY}";
      }

      await ddClient.extension.vm?.service?.post("/config", {
        ...config,
        llm_api_key: apiKeyValue,
        database_url: useCustomDb ? databaseUrl || undefined : undefined,
      });
      setApiKey("");
      await fetchSecrets();

      const result = await applyConfig();
      setSaveStatus("");

      if (result.errors && result.errors.length > 0) {
        setSaveError(
          "Configuration saved but some banks failed to update: " +
            result.errors.join("; ")
        );
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 10000);
      }

      if (result.note) {
        setSaveError(result.note);
      }
    } catch (e: any) {
      setSaveStatus("");
      setSaveError(e?.message || "Failed to save configuration");
    }
    setSaving(false);
  };

  // Save from YAML mode
  const handleSaveYAML = async () => {
    const yamlText = modelRef.current?.getValue() ?? "";
    if (!yamlText.trim()) {
      setSaveError("YAML is empty");
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError("");
    setSaveStatus("Saving YAML configuration...");
    try {
      // Send raw YAML text to backend
      const res = await ddClient.extension.vm?.service?.post("/config/yaml", yamlText);
      if (res?.error) {
        setSaveStatus("");
        setSaveError(res.error);
        setSaving(false);
        return;
      }

      await fetchSecrets();
      const result = await applyConfig();
      setSaveStatus("");

      if (result.errors && result.errors.length > 0) {
        setSaveError(
          "YAML saved but some banks failed to update: " +
            result.errors.join("; ")
        );
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 10000);
      }

      if (result.note) {
        setSaveError(result.note);
      }
    } catch (e: any) {
      setSaveStatus("");
      setSaveError(e?.message || "Failed to save YAML configuration");
    }
    setSaving(false);
  };

  const needsApiKey = config.llm_provider !== "none" && config.llm_provider !== "ollama" && config.llm_provider !== "lmstudio" && config.llm_provider !== "mock";
  const needsBaseUrl =
    config.llm_provider === "ollama" || config.llm_provider === "openai" || config.llm_provider === "lmstudio";

  return (
    <Box>
      {/* Mode Toggle */}
      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}>
        <Tabs value={mode} onChange={handleModeChange}>
          <Tab icon={<SettingsIcon />} iconPosition="start" label="Basic" />
          <Tab icon={<CodeIcon />} iconPosition="start" label="Advanced (YAML)" />
        </Tabs>
      </Box>

      {/* ═══════ Basic Mode ═══════ */}
      {mode === 0 && (
        <Grid container spacing={3}>
          <Grid item xs={12} md={8}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={3}>
                  <SettingsIcon color="primary" />
                  <Typography variant="h6">LLM Configuration</Typography>
                </Box>

                <Alert severity="info" sx={{ mb: 3 }}>
                  An LLM is <strong>not required</strong> for core memory operations. The{" "}
                  <code>retain</code> tool works with <code>verbatim</code> and{" "}
                  <code>chunks</code> strategies without any LLM. The <code>recall</code>{" "}
                  tool uses local embeddings. Configure an LLM only if you want advanced
                  features like fact extraction.
                </Alert>

                <FormControl fullWidth sx={{ mb: 2 }}>
                  <InputLabel>LLM Provider</InputLabel>
                  <Select
                    value={config.llm_provider}
                    label="LLM Provider"
                    onChange={(e) =>
                      setConfig({ ...config, llm_provider: e.target.value })
                    }
                  >
                    {LLM_PROVIDERS.map((p) => (
                      <MenuItem key={p.value} value={p.value}>
                        {p.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {config.llm_provider !== "none" && (
                  <TextField
                    fullWidth
                    label="Model"
                    value={config.llm_model}
                    onChange={(e) => setConfig({ ...config, llm_model: e.target.value })}
                    sx={{ mb: 2 }}
                    helperText='e.g., "gpt-4o-mini", "llama3.2", "claude-sonnet-4-20250514"'
                  />
                )}

                {needsBaseUrl && (
                  <TextField
                    fullWidth
                    label="Base URL"
                    value={config.llm_base_url}
                    onChange={(e) =>
                      setConfig({ ...config, llm_base_url: e.target.value })
                    }
                    sx={{ mb: 2 }}
                    helperText='Use host.docker.internal instead of localhost, e.g., "http://host.docker.internal:11434" for Ollama, "http://host.docker.internal:4000" for LiteLLM'
                  />
                )}

                {needsApiKey && (
                  <TextField
                    fullWidth
                    label="API Key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    sx={{ mb: 2 }}
                    helperText="Your API key (stored securely in the secret store)"
                  />
                )}

                <TextField
                  fullWidth
                  label="Max Concurrent LLM Requests"
                  type="number"
                  value={config.llm_max_concurrent}
                  onChange={(e) =>
                    setConfig({ ...config, llm_max_concurrent: e.target.value })
                  }
                  sx={{ mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={config.enable_observations === "true"}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          enable_observations: e.target.checked ? "true" : "false",
                        })
                      }
                    />
                  }
                  label="Enable Observations"
                />
                <Typography variant="body2" color="text.secondary" sx={{ ml: 4 }}>
                  When enabled, Hindsight will automatically observe and extract facts from
                  agent interactions.
                </Typography>

                <Alert severity="info" sx={{ mt: 2 }}>
                  Need per-operation LLM config (separate models for retain vs reflect)?
                  Switch to the <strong>Advanced (YAML)</strong> tab for full control.
                </Alert>

                <Box sx={{ mt: 3 }}>
                  <Button
                    variant="contained"
                    startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                    onClick={handleSaveBasic}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save & Apply"}
                  </Button>
                  {saveStatus && (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      {saveStatus}
                    </Alert>
                  )}
                  {saved && (
                    <Alert severity="success" sx={{ mt: 1 }}>
                      Configuration saved and applied to existing banks. New banks will
                    also use these settings.
                    </Alert>
                  )}
                  {saveError && (
                    <Alert severity="error" sx={{ mt: 1 }} onClose={() => setSaveError("")}>
                      {saveError}
                    </Alert>
                  )}
                </Box>
              </CardContent>
            </Card>

            <Card sx={{ mt: 3 }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={3}>
                  <StorageIcon color="primary" />
                  <Typography variant="h6">Database</Typography>
                </Box>

                <Alert severity="success" sx={{ mb: 3 }}>
                  By default, Hindsight uses a dedicated PostgreSQL container with pgvector.
                  Data is stored on a persistent Docker volume (<code>agent-memory-postgres-data</code>)
                  and survives restarts. Override below to use your own PostgreSQL instance.
                </Alert>

                <FormControlLabel
                  control={
                    <Switch
                      checked={useCustomDb}
                      onChange={(e) => setUseCustomDb(e.target.checked)}
                    />
                  }
                  label="Use custom PostgreSQL"
                />
                <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
                  Connect to your own PostgreSQL 14+ with pgvector instead of the bundled container.
                </Typography>

                <Collapse in={useCustomDb}>
                  <TextField
                    fullWidth
                    label="Database URL"
                    value={databaseUrl}
                    onChange={(e) => setDatabaseUrl(e.target.value)}
                    sx={{ mb: 2 }}
                    placeholder="postgresql://user:pass@host:5432/hindsight"
                    helperText='PostgreSQL connection string. The database must have pgvector enabled (CREATE EXTENSION vector). Requires extension restart to take effect.'
                  />
                </Collapse>
              </CardContent>
            </Card>

            <Card sx={{ mt: 3 }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={3}>
                  <MonitorHeartIcon color="primary" />
                  <Typography variant="h6">Monitoring</Typography>
                </Box>

                <Alert severity="info" sx={{ mb: 3 }}>
                  Enable OpenTelemetry tracing to send distributed traces to a Grafana
                  LGTM stack, Langfuse, or any OTLP-compatible backend. Prometheus metrics
                  are always available at{" "}
                  <code>http://localhost:8888/metrics</code>.
                </Alert>

                <FormControlLabel
                  control={
                    <Switch
                      checked={config.otel_traces_enabled === "true"}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          otel_traces_enabled: e.target.checked ? "true" : "false",
                        })
                      }
                    />
                  }
                  label="Enable OpenTelemetry Tracing"
                />
                <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
                  Send distributed traces for all memory operations and LLM calls.
                </Typography>

                {config.otel_traces_enabled === "true" && (
                  <>
                    <TextField
                      fullWidth
                      label="OTLP Endpoint"
                      value={config.otel_endpoint}
                      onChange={(e) =>
                        setConfig({ ...config, otel_endpoint: e.target.value })
                      }
                      sx={{ mb: 2 }}
                      helperText='OTLP HTTP endpoint, e.g., "http://host.docker.internal:4318" for Grafana LGTM. Use host.docker.internal instead of localhost.'
                    />

                    <TextField
                      fullWidth
                      label="OTLP Headers (optional)"
                      value={config.otel_headers}
                      onChange={(e) =>
                        setConfig({ ...config, otel_headers: e.target.value })
                      }
                      sx={{ mb: 2 }}
                      helperText='Format: "key1=value1,key2=value2". For authenticated endpoints, e.g., "Authorization=Bearer <token>".'
                    />

                    <TextField
                      fullWidth
                      label="Service Name (optional)"
                      value={config.otel_service_name}
                      onChange={(e) =>
                        setConfig({ ...config, otel_service_name: e.target.value })
                      }
                      sx={{ mb: 2 }}
                      helperText='Identifies this service in traces. Default: "hindsight-api".'
                    />

                    <TextField
                      fullWidth
                      label="Deployment Environment (optional)"
                      value={config.otel_environment}
                      onChange={(e) =>
                        setConfig({ ...config, otel_environment: e.target.value })
                      }
                      sx={{ mb: 2 }}
                      helperText='e.g., "development", "staging", "production". Default: "development".'
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={4}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Retain Strategies
                </Typography>
                <Typography variant="body2" color="text.secondary" paragraph>
                  When storing memories without an LLM, use these strategies:
                </Typography>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="primary">
                    verbatim
                  </Typography>
                  <Typography variant="body2">
                    Stores text exactly as provided. Best for short, specific facts.
                  </Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="primary">
                    chunks
                  </Typography>
                  <Typography variant="body2">
                    Splits text into overlapping chunks for better search. Best for longer
                    content.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="subtitle2" color="primary">
                    extract (requires LLM)
                  </Typography>
                  <Typography variant="body2">
                    Uses an LLM to extract discrete facts. Best quality but needs LLM
                    config.
                  </Typography>
                </Box>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Docker MCP Gateway
                </Typography>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Register Hindsight with Docker MCP Gateway:
                </Typography>
                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "background.default" }}>
                  <Typography
                    component="pre"
                    variant="body2"
                    fontFamily="monospace"
                    fontSize={11}
                    sx={{ whiteSpace: "pre-wrap" }}
                  >
                    {`docker mcp gateway connect \\
  agent-memory \\
  http://localhost:8888/mcp/default/`}
                  </Typography>
                </Paper>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={2}>
                  <VpnKeyIcon color="primary" />
                  <Typography variant="h6">Secrets</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Manage secrets referenced in your config via{" "}
                  <code>{"${secret.NAME}"}</code> placeholders. Secrets are resolved
                  into the env file at save time.
                </Typography>

                {secrets.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No <code>{"${secret.*}"}</code> placeholders in config.
                    Switch to Advanced mode to use secret placeholders.
                  </Typography>
                )}
                {secrets.map((s) => (
                  <Box key={s.name} sx={{ mb: 1.5 }}>
                    <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                      {s.exists ? (
                        <CheckCircleIcon fontSize="small" color="success" />
                      ) : (
                        <ErrorOutlineIcon fontSize="small" color="error" />
                      )}
                      <Typography variant="subtitle2" fontFamily="monospace" fontSize={12}>
                        {s.name}
                      </Typography>
                      <Typography variant="caption" color={s.exists ? "success.main" : "error.main"}>
                        {s.exists ? "set" : "missing"}
                      </Typography>
                    </Box>
                    <TextField
                      size="small"
                      fullWidth
                      type="password"
                      placeholder={s.exists ? "••••••• (update)" : "Enter value..."}
                      value={secretValues[s.name] || ""}
                      onChange={(e) =>
                        setSecretValues((prev) => ({ ...prev, [s.name]: e.target.value }))
                      }
                    />
                  </Box>
                ))}
                {secrets.length > 0 && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={savingSecrets ? <CircularProgress size={14} /> : <SaveIcon />}
                    onClick={handleSaveSecrets}
                    disabled={savingSecrets || !Object.values(secretValues).some((v) => v.trim())}
                    sx={{ mt: 1 }}
                  >
                    {savingSecrets ? "Saving..." : "Save Secrets"}
                  </Button>
                )}
                {secretsSaved && (
                  <Alert severity="success" sx={{ mt: 1 }}>
                    Secrets saved. Apply config to push changes to Hindsight.
                  </Alert>
                )}
                {secretsError && (
                  <Alert severity="error" sx={{ mt: 1 }} onClose={() => setSecretsError("")}>
                    {secretsError}
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Monitoring
                </Typography>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Hindsight exposes Prometheus metrics at <code>/metrics</code> and
                  supports OpenTelemetry distributed tracing.
                </Typography>

                <Box sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" color="primary">
                    Grafana LGTM
                  </Typography>
                  <Typography variant="body2">
                    Use a Grafana LGTM stack for traces (Tempo), metrics (Mimir), and
                    logs (Loki) in one container. Set the OTLP endpoint to{" "}
                    <code>http://host.docker.internal:4318</code>.
                  </Typography>
                </Box>

                <Box sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" color="primary">
                    Pre-built Dashboards
                  </Typography>
                  <Typography variant="body2">
                    Operations, LLM Metrics, and API Service dashboards are available
                    for import into Grafana.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="subtitle2" color="primary">
                    Compatible Backends
                  </Typography>
                  <Typography variant="body2">
                    Grafana LGTM, Langfuse, OpenLIT, DataDog, New Relic, Honeycomb — any
                    OTLP HTTP backend.
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* ═══════ Advanced YAML Mode ═══════ */}
      {mode === 1 && (
        <Grid container spacing={3}>
          <Grid item xs={12} md={8}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={2}>
                  <CodeIcon color="primary" />
                  <Typography variant="h6">YAML Configuration</Typography>
                </Box>

                <Alert severity="info" sx={{ mb: 2 }}>
                  Edit the full Hindsight configuration as YAML. Nested keys automatically
                  map to <code>HINDSIGHT_API_*</code> environment variables. For example,{" "}
                  <code>hindsight.api.llm.provider</code> becomes{" "}
                  <code>HINDSIGHT_API_LLM_PROVIDER</code>.
                </Alert>

                {!yamlLoaded ? (
                  <Box display="flex" justifyContent="center" py={4}>
                    <CircularProgress />
                  </Box>
                ) : (
                  <Box
                    ref={editorContainerRef}
                    sx={{
                      height: 520,
                      border: 1,
                      borderColor: "divider",
                      borderRadius: 1,
                      overflow: "hidden",
                    }}
                  />
                )}

                <Box sx={{ mt: 3 }}>
                  <Button
                    variant="contained"
                    startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                    onClick={handleSaveYAML}
                    disabled={saving || !yamlLoaded}
                  >
                    {saving ? "Saving..." : "Save & Apply"}
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={fetchYAML}
                    sx={{ ml: 2 }}
                    disabled={saving}
                  >
                    Reload
                  </Button>
                  {saveStatus && (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      {saveStatus}
                    </Alert>
                  )}
                  {saved && (
                    <Alert severity="success" sx={{ mt: 1 }}>
                      YAML configuration saved, env file regenerated, and applied to
                      existing banks.
                    </Alert>
                  )}
                  {saveError && (
                    <Alert severity="error" sx={{ mt: 1 }} onClose={() => setSaveError("")}>
                      {saveError}
                    </Alert>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={4}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  How It Works
                </Typography>
                <Typography variant="body2" color="text.secondary" paragraph>
                  The YAML hierarchy maps directly to Hindsight environment variables:
                </Typography>
                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "background.default", mb: 2 }}>
                  <Typography
                    component="pre"
                    variant="body2"
                    fontFamily="monospace"
                    fontSize={11}
                    sx={{ whiteSpace: "pre-wrap" }}
                  >
{`hindsight:
  api:
    llm:
      provider: openai
# becomes:
# HINDSIGHT_API_LLM_PROVIDER=openai`}
                  </Typography>
                </Paper>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Any <Link href="https://hindsight.vectorize.io/developer/configuration" target="_blank" rel="noopener">
                  Hindsight env var</Link> is configurable — just express it as nested YAML.
                </Typography>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={2}>
                  <VpnKeyIcon color="primary" />
                  <Typography variant="h6">Secrets</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Use <code>{"${secret.NAME}"}</code> placeholders in your YAML for
                  sensitive values. Secrets are resolved into the env file when you
                  save.
                </Typography>

                {secrets.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No <code>{"${secret.*}"}</code> placeholders in your YAML yet.
                    Add one (e.g. <code>{"api_key: ${secret.LLM_API_KEY}"}</code>) and
                    save to see it here.
                  </Typography>
                )}
                {secrets.map((s) => (
                  <Box key={s.name} sx={{ mb: 1.5 }}>
                    <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                      {s.exists ? (
                        <CheckCircleIcon fontSize="small" color="success" />
                      ) : (
                        <ErrorOutlineIcon fontSize="small" color="error" />
                      )}
                      <Typography variant="subtitle2" fontFamily="monospace" fontSize={12}>
                        {s.name}
                      </Typography>
                      <Typography variant="caption" color={s.exists ? "success.main" : "error.main"}>
                        {s.exists ? "set" : "missing"}
                      </Typography>
                    </Box>
                    <TextField
                      size="small"
                      fullWidth
                      type="password"
                      placeholder={s.exists ? "••••••• (update)" : "Enter value..."}
                      value={secretValues[s.name] || ""}
                      onChange={(e) =>
                        setSecretValues((prev) => ({ ...prev, [s.name]: e.target.value }))
                      }
                    />
                  </Box>
                ))}
                {secrets.length > 0 && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={savingSecrets ? <CircularProgress size={14} /> : <SaveIcon />}
                    onClick={handleSaveSecrets}
                    disabled={savingSecrets || !Object.values(secretValues).some((v) => v.trim())}
                    sx={{ mt: 1 }}
                  >
                    {savingSecrets ? "Saving..." : "Save Secrets"}
                  </Button>
                )}
                {secretsSaved && (
                  <Alert severity="success" sx={{ mt: 1 }}>
                    Secrets saved. Click "Save & Apply" to push to Hindsight.
                  </Alert>
                )}
                {secretsError && (
                  <Alert severity="error" sx={{ mt: 1 }} onClose={() => setSecretsError("")}>
                    {secretsError}
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Per-Operation LLM
                </Typography>
                <Typography variant="body2" color="text.secondary" paragraph>
                  Use different models for different operations. Based on{" "}
                  <Link href="https://benchmarks.hindsight.vectorize.io/" target="_blank" rel="noopener">
                  benchmarks</Link>:
                </Typography>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="primary">
                    Retain (fact extraction)
                  </Typography>
                  <Typography variant="body2">
                    Best: <code>openai/gpt-oss-20b</code> via Groq (81.2 score).
                    Needs structured output capability.
                  </Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="primary">
                    Reflect (reasoning)
                  </Typography>
                  <Typography variant="body2">
                    Best: <code>openai/gpt-oss-120b</code> via Groq (86.6 score, 94% accuracy).
                    Benefits from fast inference.
                  </Typography>
                </Box>

                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "background.default" }}>
                  <Typography
                    component="pre"
                    variant="body2"
                    fontFamily="monospace"
                    fontSize={11}
                    sx={{ whiteSpace: "pre-wrap" }}
                  >
{`# Example: per-operation config
hindsight:
  api:
    llm:
      provider: openai
      model: gpt-4o-mini
      api_key: \${secret.LLM_API_KEY}
    retain:
      llm:
        provider: groq
        model: openai/gpt-oss-20b
        api_key: \${secret.GROQ_API_KEY}
    reflect:
      llm:
        provider: groq
        model: openai/gpt-oss-120b
        api_key: \${secret.GROQ_API_KEY}`}
                  </Typography>
                </Paper>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Common Sections
                </Typography>
                <Typography variant="body2" color="text.secondary" component="div">
                  <Box component="ul" sx={{ pl: 2, m: 0 }}>
                    <li><code>llm</code> — Global LLM settings</li>
                    <li><code>retain.llm</code> — Per-retain LLM override</li>
                    <li><code>reflect.llm</code> — Per-reflect LLM override</li>
                    <li><code>consolidation.llm</code> — Observation LLM</li>
                    <li><code>embeddings</code> — Embedding model config</li>
                    <li><code>reranker</code> — Reranker config</li>
                    <li><code>database</code> — PostgreSQL connection</li>
                    <li><code>otel</code> — OpenTelemetry tracing</li>
                    <li><code>disposition</code> — Reflect personality</li>
                    <li><code>retain</code> — Extraction tuning</li>
                  </Box>
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}
