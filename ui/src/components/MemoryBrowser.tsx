import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import AccountTreeIcon from "@mui/icons-material/AccountTree";

interface MemoryBrowserProps {
  ddClient: any;
}

interface Bank {
  bank_id: string;
  name?: string;
  mission?: string;
  directives?: string[];
  memory_count?: number;
}

interface RecallResult {
  content: string;
  score?: number;
  metadata?: any;
}

export default function MemoryBrowser({ ddClient }: MemoryBrowserProps) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RecallResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newBankId, setNewBankId] = useState("");
  const [newBankMission, setNewBankMission] = useState("");

  const fetchBanks = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await ddClient.extension.vm?.service?.get("/banks");
      if (Array.isArray(res)) {
        setBanks(res);
      } else {
        setBanks([]);
      }
    } catch (e: any) {
      setError("Failed to fetch banks. Hindsight may still be starting.");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchBanks();
  }, []);

  const handleCreateBank = async () => {
    if (!newBankId.trim()) return;
    try {
      await ddClient.extension.vm?.service?.post("/banks", {
        id: newBankId.trim(),
        mission: newBankMission.trim() || undefined,
      });
      setCreateOpen(false);
      setNewBankId("");
      setNewBankMission("");
      fetchBanks();
    } catch (e: any) {
      setError("Failed to create bank: " + (e.message || String(e)));
    }
  };

  const handleSearch = async () => {
    if (!selectedBank || !searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const res = await ddClient.extension.vm?.service?.post("/recall", {
        bank_id: selectedBank,
        query: searchQuery.trim(),
        n: 10,
      });
      if (Array.isArray(res?.results)) {
        setSearchResults(res.results);
      } else if (Array.isArray(res)) {
        setSearchResults(res);
      } else {
        setSearchResults([]);
      }
    } catch (e: any) {
      setError("Search failed: " + (e.message || String(e)));
    }
    setSearching(false);
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">Memory Banks</Typography>
        <Box display="flex" gap={1}>
          <Button startIcon={<RefreshIcon />} onClick={fetchBanks} size="small">
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            size="small"
          >
            Create Bank
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 1, maxHeight: 500, overflow: "auto" }}>
            {banks.length === 0 ? (
              <Box p={3} textAlign="center">
                <AccountTreeIcon sx={{ fontSize: 48, opacity: 0.3 }} />
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  No memory banks yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Create one to start storing agent memories
                </Typography>
              </Box>
            ) : (
              <List dense>
                {banks.map((bank) => (
                  <ListItem
                    key={bank.bank_id}
                    onClick={() => setSelectedBank(bank.bank_id)}
                    sx={{
                      cursor: "pointer",
                      borderRadius: 1,
                      bgcolor:
                        selectedBank === bank.bank_id
                          ? "action.selected"
                          : "transparent",
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <ListItemText
                      primary={bank.bank_id}
                      secondary={bank.mission || "No mission set"}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} md={8}>
          {selectedBank ? (
            <Box>
              <Card sx={{ mb: 2 }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    {selectedBank}
                  </Typography>
                  <Chip label={`Bank ID: ${selectedBank}`} size="small" />
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    MCP Endpoint:{" "}
                    <code>http://localhost:8888/mcp/{selectedBank}/</code>
                  </Typography>
                </CardContent>
              </Card>

              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Search Memories
                </Typography>
                <Box display="flex" gap={1}>
                  <TextField
                    fullWidth
                    size="small"
                    placeholder="Search query..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  />
                  <IconButton onClick={handleSearch} color="primary" disabled={searching}>
                    {searching ? <CircularProgress size={24} /> : <SearchIcon />}
                  </IconButton>
                </Box>

                {searchResults.length > 0 && (
                  <List sx={{ mt: 2 }}>
                    {searchResults.map((result, i) => (
                      <ListItem key={i} divider>
                        <ListItemText
                          primary={
                            typeof result === "string"
                              ? result
                              : result.content || JSON.stringify(result)
                          }
                          secondary={
                            result.score !== undefined
                              ? `Relevance: ${(result.score * 100).toFixed(1)}%`
                              : undefined
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}

                {searchResults.length === 0 && searchQuery && !searching && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 2, textAlign: "center" }}
                  >
                    No results. Try a different query or store some memories first.
                  </Typography>
                )}
              </Paper>
            </Box>
          ) : (
            <Paper sx={{ p: 4, textAlign: "center" }}>
              <Typography color="text.secondary">
                Select a bank to browse memories
              </Typography>
            </Paper>
          )}
        </Grid>
      </Grid>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create Memory Bank</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Bank ID"
            fullWidth
            value={newBankId}
            onChange={(e) => setNewBankId(e.target.value)}
            helperText='Unique identifier (e.g., "project-alpha", "shared-context")'
          />
          <TextField
            margin="dense"
            label="Mission (optional)"
            fullWidth
            multiline
            rows={2}
            value={newBankMission}
            onChange={(e) => setNewBankMission(e.target.value)}
            helperText="Describe what this memory bank is for"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCreateBank} disabled={!newBankId.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
