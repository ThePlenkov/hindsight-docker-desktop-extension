import { useEffect, useState, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import PsychologyIcon from "@mui/icons-material/Psychology";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteIcon from "@mui/icons-material/Delete";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";

interface ReflectPanelProps {
  ddClient: any;
}

interface Bank {
  bank_id: string;
  mission?: string;
}

interface MentalModel {
  mental_model_id: string;
  name: string;
  source_query: string;
  content?: string;
  tags?: string[];
  status?: string;
  created_at?: string;
  updated_at?: string;
  trigger_refresh_after_consolidation?: boolean;
}

interface ReflectResponse {
  text?: string;
  based_on?: {
    memories?: { id: string; text: string; type: string; context?: string }[];
    mental_models?: { id: string; text: string; context?: string }[];
    directives?: { id: string; name: string; content: string }[];
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: string;
}

export default function ReflectPanel({ ddClient }: ReflectPanelProps) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedBank, setSelectedBank] = useState("");

  // Reflect state
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState<string>("low");
  const [includeFacts, setIncludeFacts] = useState(true);
  const [reflecting, setReflecting] = useState(false);
  const [response, setResponse] = useState<ReflectResponse | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // Mental models state
  const [models, setModels] = useState<MentalModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<MentalModel | null>(null);
  const [modelDetail, setModelDetail] = useState<MentalModel | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [newModelQuery, setNewModelQuery] = useState("");
  const [newModelAutoRefresh, setNewModelAutoRefresh] = useState(true);
  const [refreshingModel, setRefreshingModel] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await ddClient.extension.vm?.service?.get("/banks");
        if (Array.isArray(res)) {
          setBanks(res);
          if (res.length > 0) setSelectedBank(res[0].bank_id);
        }
      } catch (e: any) {
        setError("Failed to fetch banks.");
      }
      setLoading(false);
    })();
  }, []);

  const fetchModels = useCallback(async () => {
    if (!selectedBank) return;
    setModelsLoading(true);
    try {
      const res = await ddClient.extension.vm?.service?.get(
        `/banks/${selectedBank}/mental-models`
      );
      const list = res?.mental_models ?? res ?? [];
      if (Array.isArray(list)) {
        setModels(list);
      } else {
        setModels([]);
      }
    } catch (e: any) {
      // Not critical - bank may just have no models
      setModels([]);
    }
    setModelsLoading(false);
  }, [selectedBank]);

  useEffect(() => {
    fetchModels();
    setSelectedModel(null);
    setModelDetail(null);
  }, [selectedBank, fetchModels]);

  const fetchModelDetail = async (modelId: string) => {
    try {
      const res = await ddClient.extension.vm?.service?.get(
        `/banks/${selectedBank}/mental-models/${modelId}`
      );
      setModelDetail(res);
    } catch (e: any) {
      setError("Failed to load mental model: " + (e.message || String(e)));
    }
  };

  const handleSelectModel = (model: MentalModel) => {
    setSelectedModel(model);
    fetchModelDetail(model.mental_model_id);
  };

  const handleCreateModel = async () => {
    if (!newModelName.trim() || !newModelQuery.trim() || !selectedBank) return;
    try {
      await ddClient.extension.vm?.service?.post(
        `/banks/${selectedBank}/mental-models`,
        {
          name: newModelName.trim(),
          source_query: newModelQuery.trim(),
          trigger_refresh_after_consolidation: newModelAutoRefresh,
        }
      );
      setCreateOpen(false);
      setNewModelName("");
      setNewModelQuery("");
      setNewModelAutoRefresh(true);
      fetchModels();
    } catch (e: any) {
      setError("Failed to create mental model: " + (e.message || String(e)));
    }
  };

  const handleRefreshModel = async (modelId: string) => {
    setRefreshingModel(modelId);
    try {
      await ddClient.extension.vm?.service?.post(
        `/banks/${selectedBank}/mental-models/${modelId}/refresh`,
        {}
      );
      // Wait a moment then re-fetch
      setTimeout(() => {
        fetchModelDetail(modelId);
        fetchModels();
        setRefreshingModel(null);
      }, 2000);
    } catch (e: any) {
      setError("Failed to refresh model: " + (e.message || String(e)));
      setRefreshingModel(null);
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    try {
      await ddClient.extension.vm?.service?.request(
        `/banks/${selectedBank}/mental-models/${modelId}`,
        { method: "DELETE" }
      );
      setSelectedModel(null);
      setModelDetail(null);
      fetchModels();
    } catch {
      // Fallback: some DD client versions don't support .request()
      try {
        await ddClient.extension.vm?.service?.delete(
          `/banks/${selectedBank}/mental-models/${modelId}`
        );
        setSelectedModel(null);
        setModelDetail(null);
        fetchModels();
      } catch (e: any) {
        setError("Failed to delete model: " + (e.message || String(e)));
      }
    }
  };

  const handleReflect = async () => {
    if (!selectedBank || !query.trim()) return;
    setReflecting(true);
    setResponse(null);
    setError("");
    try {
      const body: any = {
        bank_id: selectedBank,
        query: query.trim(),
        budget,
      };
      if (includeFacts) {
        body.include = { facts: {} };
      }
      const res = await ddClient.extension.vm?.service?.post("/reflect", body);
      if (res?.error) {
        setError(typeof res.error === "string" ? res.error : JSON.stringify(res.error));
      } else {
        setResponse(res);
      }
    } catch (e: any) {
      setError("Reflect failed: " + (e.message || String(e)));
    }
    setReflecting(false);
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  const hasSources =
    response?.based_on &&
    ((response.based_on.memories?.length ?? 0) > 0 ||
      (response.based_on.mental_models?.length ?? 0) > 0 ||
      (response.based_on.directives?.length ?? 0) > 0);

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1} mb={2}>
        <PsychologyIcon />
        <Typography variant="h6">Reflect</Typography>
        <Typography variant="body2" color="text.secondary">
          Synthesized reasoning and living knowledge over memories
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Left sidebar */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel>Memory Bank</InputLabel>
              <Select
                value={selectedBank}
                label="Memory Bank"
                onChange={(e) => setSelectedBank(e.target.value)}
              >
                {banks.map((b) => (
                  <MenuItem key={b.bank_id} value={b.bank_id}>
                    {b.bank_id}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel>Budget</InputLabel>
              <Select
                value={budget}
                label="Budget"
                onChange={(e) => setBudget(e.target.value)}
              >
                <MenuItem value="low">Low (fast)</MenuItem>
                <MenuItem value="mid">Mid (balanced)</MenuItem>
                <MenuItem value="high">High (thorough)</MenuItem>
              </Select>
            </FormControl>

            <FormControlLabel
              control={
                <Switch
                  checked={includeFacts}
                  onChange={(e) => setIncludeFacts(e.target.checked)}
                  size="small"
                />
              }
              label="Include sources"
            />
          </Paper>

          {/* Mental Models */}
          <Paper sx={{ p: 2 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
              <Box display="flex" alignItems="center" gap={0.5}>
                <AutoAwesomeIcon fontSize="small" />
                <Typography variant="subtitle2">Mental Models</Typography>
              </Box>
              <Box display="flex" gap={0.5}>
                <Tooltip title="Refresh list">
                  <IconButton size="small" onClick={fetchModels} disabled={modelsLoading}>
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Create mental model">
                  <IconButton size="small" onClick={() => setCreateOpen(true)} disabled={!selectedBank}>
                    <AddIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              Living documents that auto-synthesize knowledge from memories.
              Agents use these for self-reflection.
            </Typography>

            {modelsLoading ? (
              <Box display="flex" justifyContent="center" p={2}>
                <CircularProgress size={20} />
              </Box>
            ) : models.length === 0 ? (
              <Box p={2} textAlign="center">
                <Typography variant="body2" color="text.secondary">
                  No mental models yet
                </Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => setCreateOpen(true)}
                  sx={{ mt: 1 }}
                  disabled={!selectedBank}
                >
                  Create one
                </Button>
              </Box>
            ) : (
              <List dense disablePadding sx={{ maxHeight: 300, overflow: "auto" }}>
                {models.map((m) => (
                  <ListItemButton
                    key={m.mental_model_id}
                    selected={selectedModel?.mental_model_id === m.mental_model_id}
                    onClick={() => handleSelectModel(m)}
                    sx={{ borderRadius: 1, py: 0.5 }}
                  >
                    <ListItemText
                      primary={m.name}
                      secondary={m.source_query}
                      primaryTypographyProps={{ variant: "body2", fontWeight: "medium" }}
                      secondaryTypographyProps={{
                        variant: "caption",
                        noWrap: true,
                        title: m.source_query,
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Paper>
        </Grid>

        {/* Right panel */}
        <Grid item xs={12} md={8}>
          {/* Mental Model detail */}
          {modelDetail && (
            <Card sx={{ mb: 2 }}>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                  <Box>
                    <Box display="flex" alignItems="center" gap={1}>
                      <AutoAwesomeIcon fontSize="small" color="primary" />
                      <Typography variant="h6">{modelDetail.name}</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      Query: {modelDetail.source_query}
                    </Typography>
                  </Box>
                  <Box display="flex" gap={0.5}>
                    <Tooltip title="Refresh content">
                      <IconButton
                        size="small"
                        onClick={() => handleRefreshModel(modelDetail.mental_model_id)}
                        disabled={refreshingModel === modelDetail.mental_model_id}
                      >
                        {refreshingModel === modelDetail.mental_model_id ? (
                          <CircularProgress size={18} />
                        ) : (
                          <RefreshIcon fontSize="small" />
                        )}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleDeleteModel(modelDetail.mental_model_id)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>

                <Divider sx={{ my: 1.5 }} />

                <Typography
                  variant="body2"
                  sx={{
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.7,
                    maxHeight: 300,
                    overflow: "auto",
                  }}
                >
                  {modelDetail.content || "(Content is being generated...)"}
                </Typography>

                <Box display="flex" gap={1} mt={1.5} flexWrap="wrap">
                  {modelDetail.tags?.map((t) => (
                    <Chip key={t} label={t} size="small" variant="outlined" />
                  ))}
                  {modelDetail.status && (
                    <Chip
                      label={modelDetail.status}
                      size="small"
                      color={modelDetail.status === "ready" ? "success" : "default"}
                    />
                  )}
                  {modelDetail.trigger_refresh_after_consolidation && (
                    <Chip label="auto-refresh" size="small" color="info" variant="outlined" />
                  )}
                </Box>
              </CardContent>
            </Card>
          )}

          {/* Reflect query form */}
          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Ad-hoc Reflect
            </Typography>
            <TextField
              fullWidth
              multiline
              minRows={3}
              maxRows={8}
              placeholder="Ask a question to reflect on... e.g. 'What patterns have emerged in how I approach debugging?'"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.ctrlKey) handleReflect();
              }}
              sx={{ mb: 2 }}
            />
            <Box display="flex" justifyContent="space-between" alignItems="center">
              <Typography variant="caption" color="text.secondary">
                Ctrl+Enter to submit
              </Typography>
              <Button
                variant="contained"
                startIcon={
                  reflecting ? (
                    <CircularProgress size={18} color="inherit" />
                  ) : (
                    <PsychologyIcon />
                  )
                }
                onClick={handleReflect}
                disabled={reflecting || !selectedBank || !query.trim()}
              >
                {reflecting ? "Reflecting..." : "Reflect"}
              </Button>
            </Box>
          </Paper>

          {/* Reflect response */}
          {response && (
            <Card>
              <CardContent>
                <Typography
                  variant="body1"
                  sx={{
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.7,
                    "& code": {
                      bgcolor: "action.hover",
                      px: 0.5,
                      borderRadius: 0.5,
                      fontFamily: "monospace",
                      fontSize: "0.9em",
                    },
                  }}
                >
                  {response.text || "(No text in response)"}
                </Typography>

                {response.usage && (
                  <Box display="flex" gap={1} mt={2}>
                    <Chip
                      size="small"
                      label={`Input: ${response.usage.input_tokens}`}
                      variant="outlined"
                    />
                    <Chip
                      size="small"
                      label={`Output: ${response.usage.output_tokens}`}
                      variant="outlined"
                    />
                    <Chip
                      size="small"
                      label={`Total: ${response.usage.total_tokens}`}
                      variant="outlined"
                    />
                  </Box>
                )}

                {hasSources && (
                  <Box sx={{ mt: 2 }}>
                    <Button
                      size="small"
                      onClick={() => setSourcesOpen(!sourcesOpen)}
                      endIcon={sourcesOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                    >
                      Sources (
                      {(response.based_on!.memories?.length ?? 0) +
                        (response.based_on!.mental_models?.length ?? 0) +
                        (response.based_on!.directives?.length ?? 0)}
                      )
                    </Button>
                    <Collapse in={sourcesOpen}>
                      <Box sx={{ mt: 1, pl: 1, borderLeft: 2, borderColor: "divider" }}>
                        {(response.based_on!.memories?.length ?? 0) > 0 && (
                          <>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontWeight="bold"
                            >
                              Memories
                            </Typography>
                            <List dense disablePadding>
                              {response.based_on!.memories!.map((m, i) => (
                                <ListItem key={m.id || i} disableGutters sx={{ py: 0.25 }}>
                                  <ListItemText
                                    primary={m.text}
                                    secondary={
                                      m.type
                                        ? `[${m.type}]${m.context ? ` ${m.context}` : ""}`
                                        : undefined
                                    }
                                    primaryTypographyProps={{ variant: "body2" }}
                                    secondaryTypographyProps={{ variant: "caption" }}
                                  />
                                </ListItem>
                              ))}
                            </List>
                          </>
                        )}
                        {(response.based_on!.mental_models?.length ?? 0) > 0 && (
                          <>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontWeight="bold"
                              sx={{ mt: 1, display: "block" }}
                            >
                              Mental Models
                            </Typography>
                            <List dense disablePadding>
                              {response.based_on!.mental_models!.map((m, i) => (
                                <ListItem key={m.id || i} disableGutters sx={{ py: 0.25 }}>
                                  <ListItemText
                                    primary={m.text}
                                    primaryTypographyProps={{ variant: "body2" }}
                                  />
                                </ListItem>
                              ))}
                            </List>
                          </>
                        )}
                        {(response.based_on!.directives?.length ?? 0) > 0 && (
                          <>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontWeight="bold"
                              sx={{ mt: 1, display: "block" }}
                            >
                              Directives
                            </Typography>
                            <List dense disablePadding>
                              {response.based_on!.directives!.map((d, i) => (
                                <ListItem key={d.id || i} disableGutters sx={{ py: 0.25 }}>
                                  <ListItemText
                                    primary={d.name}
                                    secondary={d.content}
                                    primaryTypographyProps={{
                                      variant: "body2",
                                      fontWeight: "bold",
                                    }}
                                    secondaryTypographyProps={{ variant: "caption" }}
                                  />
                                </ListItem>
                              ))}
                            </List>
                          </>
                        )}
                      </Box>
                    </Collapse>
                  </Box>
                )}
              </CardContent>
            </Card>
          )}
        </Grid>
      </Grid>

      {/* Create Mental Model Dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create Mental Model</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            A mental model is a living document generated by running a source
            query through reflect. It stays current as new memories are added.
          </Typography>
          <TextField
            autoFocus
            margin="dense"
            label="Name"
            fullWidth
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            helperText='e.g. "Coding Preferences", "Project Goals", "User Communication Style"'
          />
          <TextField
            margin="dense"
            label="Source Query"
            fullWidth
            multiline
            rows={3}
            value={newModelQuery}
            onChange={(e) => setNewModelQuery(e.target.value)}
            helperText="The question to run through reflect to generate content. e.g. 'What coding patterns and tools does the user prefer?'"
          />
          <FormControlLabel
            control={
              <Switch
                checked={newModelAutoRefresh}
                onChange={(e) => setNewModelAutoRefresh(e.target.checked)}
                size="small"
              />
            }
            label="Auto-refresh after memory consolidation"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreateModel}
            disabled={!newModelName.trim() || !newModelQuery.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
