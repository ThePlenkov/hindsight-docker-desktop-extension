import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import PsychologyIcon from "@mui/icons-material/Psychology";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";

interface ReflectPanelProps {
  ddClient: any;
}

interface Bank {
  bank_id: string;
  mission?: string;
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
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState<string>("low");
  const [includeFacts, setIncludeFacts] = useState(true);
  const [reflecting, setReflecting] = useState(false);
  const [response, setResponse] = useState<ReflectResponse | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

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
          Synthesized, disposition-aware reasoning over memories
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
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

            <Box sx={{ mt: 2, p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
              <Typography variant="caption" color="text.secondary">
                <strong>Reflect</strong> runs an agentic reasoning loop that
                searches memories and synthesizes a grounded answer. Unlike
                recall (raw fact retrieval), reflect produces a thoughtful
                response shaped by the bank's personality.
              </Typography>
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 2, mb: 2 }}>
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
                startIcon={reflecting ? <CircularProgress size={18} color="inherit" /> : <PsychologyIcon />}
                onClick={handleReflect}
                disabled={reflecting || !selectedBank || !query.trim()}
              >
                {reflecting ? "Reflecting..." : "Reflect"}
              </Button>
            </Box>
          </Paper>

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
                      Sources ({
                        (response.based_on!.memories?.length ?? 0) +
                        (response.based_on!.mental_models?.length ?? 0) +
                        (response.based_on!.directives?.length ?? 0)
                      })
                    </Button>
                    <Collapse in={sourcesOpen}>
                      <Box sx={{ mt: 1, pl: 1, borderLeft: 2, borderColor: "divider" }}>
                        {(response.based_on!.memories?.length ?? 0) > 0 && (
                          <>
                            <Typography variant="caption" color="text.secondary" fontWeight="bold">
                              Memories
                            </Typography>
                            <List dense disablePadding>
                              {response.based_on!.memories!.map((m, i) => (
                                <ListItem key={m.id || i} disableGutters sx={{ py: 0.25 }}>
                                  <ListItemText
                                    primary={m.text}
                                    secondary={m.type ? `[${m.type}]${m.context ? ` ${m.context}` : ""}` : undefined}
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
                            <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ mt: 1, display: "block" }}>
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
                            <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ mt: 1, display: "block" }}>
                              Directives
                            </Typography>
                            <List dense disablePadding>
                              {response.based_on!.directives!.map((d, i) => (
                                <ListItem key={d.id || i} disableGutters sx={{ py: 0.25 }}>
                                  <ListItemText
                                    primary={d.name}
                                    secondary={d.content}
                                    primaryTypographyProps={{ variant: "body2", fontWeight: "bold" }}
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
    </Box>
  );
}
