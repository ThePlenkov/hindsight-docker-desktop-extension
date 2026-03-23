package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// hindsightURLs lists the candidate base URLs for the Hindsight API.
// The backend tries each in order and caches the first one that responds.
var hindsightURLs = []string{
	"http://hindsight:8888",
	"http://localhost:8888",
	"http://127.0.0.1:8888",
}

var (
	resolvedBase   string
	resolvedBaseMu sync.RWMutex
)

// getHindsightBase returns the cached base URL or probes all candidates.
func getHindsightBase() string {
	resolvedBaseMu.RLock()
	base := resolvedBase
	resolvedBaseMu.RUnlock()
	if base != "" {
		return base
	}
	return probeHindsight()
}

// probeHindsight tries each candidate URL and caches the first healthy one.
func probeHindsight() string {
	client := &http.Client{Timeout: 3 * time.Second}
	for _, u := range hindsightURLs {
		resp, err := client.Get(u + "/health")
		if err == nil {
			resp.Body.Close()
			log.Printf("hindsight discovered at %s", u)
			resolvedBaseMu.Lock()
			resolvedBase = u
			resolvedBaseMu.Unlock()
			return u
		}
	}
	// Return first candidate so callers still get a meaningful error
	return hindsightURLs[0]
}

// resetHindsightBase clears the cache so the next call re-probes.
func resetHindsightBase() {
	resolvedBaseMu.Lock()
	resolvedBase = ""
	resolvedBaseMu.Unlock()
}

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "socket", "/run/guest-services/agent-memory.sock", "Unix socket path")
	flag.Parse()

	_ = os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("failed to listen on %s: %v", socketPath, err)
	}
	defer listener.Close()

	mux := http.NewServeMux()

	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.HandleFunc("/banks", handleBanks)
	mux.HandleFunc("/banks/", handleBankByID)
	mux.HandleFunc("/retain", handleRetain)
	mux.HandleFunc("/recall", handleRecall)
	mux.HandleFunc("/reflect", handleReflect)
	mux.HandleFunc("/config", handleConfig)
	mux.HandleFunc("/restart", handleRestart)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf(">> %s %s", r.Method, r.URL.Path)
		mux.ServeHTTP(w, r)
	})

	server := &http.Server{Handler: handler}

	go func() {
		log.Printf("backend listening on %s", socketPath)
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Config is loaded by the Hindsight entrypoint wrapper from the shared
	// /config volume at container startup. Generate the env file from any
	// existing config so Hindsight picks it up.
	cfg := loadConfig()
	if cfg.LLMProvider != "" && cfg.LLMProvider != "none" {
		if err := writeEnvFile(cfg); err != nil {
			log.Printf("WARNING: failed to write env file: %v", err)
		} else {
			log.Printf("wrote hindsight.env: provider=%s model=%s", cfg.LLMProvider, cfg.LLMModel)
		}
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctx)
	log.Println("server stopped")
}

// proxyToHindsight forwards a request to the Hindsight API and writes the response back.
func proxyToHindsight(w http.ResponseWriter, method, path string, body io.Reader) {
	proxyToHindsightWithTimeout(w, method, path, body, 30*time.Second)
}

// proxyToHindsightWithTimeout is like proxyToHindsight but with a configurable timeout.
func proxyToHindsightWithTimeout(w http.ResponseWriter, method, path string, body io.Reader, timeout time.Duration) {
	base := getHindsightBase()
	url := base + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("create request: %v", err)})
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		// Clear cache so next request re-probes
		resetHindsightBase()
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":   fmt.Sprintf("hindsight unreachable at %s: %v", base, err),
			"details": "Hindsight may still be starting up. It takes 10-15 seconds for Postgres to initialize.",
		})
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Try each candidate URL to find hindsight
	client := &http.Client{Timeout: 2 * time.Second}
	var lastErr error
	var triedURLs []string

	for _, base := range hindsightURLs {
		triedURLs = append(triedURLs, base)
		resp, err := client.Get(base + "/health")
		if err != nil {
			lastErr = err
			continue
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)

		// Cache this working URL
		resolvedBaseMu.Lock()
		resolvedBase = base
		resolvedBaseMu.Unlock()

		if resp.StatusCode == http.StatusOK {
			var healthData interface{}
			if json.Unmarshal(body, &healthData) == nil {
				writeJSON(w, http.StatusOK, map[string]interface{}{
					"status":         "running",
					"hindsight":      true,
					"hindsight_url":  base,
					"details":        healthData,
				})
			} else {
				writeJSON(w, http.StatusOK, map[string]interface{}{
					"status":         "running",
					"hindsight":      true,
					"hindsight_url":  base,
					"raw":            string(body),
				})
			}
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":         "unhealthy",
			"hindsight":      false,
			"hindsight_url":  base,
			"code":           resp.StatusCode,
			"body":           string(body),
		})
		return
	}

	// None of the URLs responded
	resetHindsightBase()
	errMsg := "connection refused"
	if lastErr != nil {
		errMsg = lastErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":      "starting",
		"hindsight":   false,
		"message":     fmt.Sprintf("Hindsight is not reachable. Tried: %s", strings.Join(triedURLs, ", ")),
		"last_error":  errMsg,
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	base := getHindsightBase()
	status := map[string]interface{}{
		"mcp_endpoint":  "http://localhost:8888/mcp/{bank_id}/",
		"api_endpoint":  "http://localhost:8888",
		"ui_endpoint":   "http://localhost:9999",
		"hindsight_url": base,
	}

	// Try to get banks to count memories
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/v1/default/banks")
	if err != nil {
		resetHindsightBase()
		status["hindsight_ready"] = false
		status["banks"] = 0
		status["error"] = err.Error()
		writeJSON(w, http.StatusOK, status)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	// Hindsight returns {"banks": [...]}
	var wrapped map[string]interface{}
	if json.Unmarshal(body, &wrapped) == nil {
		if banksList, ok := wrapped["banks"].([]interface{}); ok {
			status["hindsight_ready"] = true
			status["bank_count"] = len(banksList)
			status["banks"] = banksList
		} else {
			status["hindsight_ready"] = true
			status["bank_count"] = 0
		}
	} else {
		status["hindsight_ready"] = true
		status["banks_raw"] = string(body)
	}

	writeJSON(w, http.StatusOK, status)
}

func handleBanks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// Hindsight returns {"banks": [...]}, unwrap to a plain array for the UI
		base := getHindsightBase()
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(base + "/v1/default/banks")
		if err != nil {
			resetHindsightBase()
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error":   fmt.Sprintf("hindsight unreachable at %s: %v", base, err),
				"details": "Hindsight may still be starting up.",
			})
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)

		var wrapped map[string]json.RawMessage
		if json.Unmarshal(body, &wrapped) == nil {
			if banksRaw, ok := wrapped["banks"]; ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write(banksRaw)
				return
			}
		}
		// Fallback: pass through as-is
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(body)
	case http.MethodPost:
		// Hindsight creates banks via PUT /v1/default/banks/{bank_id}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
			return
		}
		var req map[string]interface{}
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		bankID, ok := req["id"].(string)
		if !ok || bankID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
			return
		}
		proxyToHindsight(w, "PUT", "/v1/default/banks/"+bankID, strings.NewReader(string(body)))
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func handleBankByID(w http.ResponseWriter, r *http.Request) {
	// Extract bank ID from path: /banks/{id}
	path := strings.TrimPrefix(r.URL.Path, "/banks/")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bank id required"})
		return
	}

	// Handle sub-routes like /banks/{id}/retain, /banks/{id}/recall
	parts := strings.SplitN(path, "/", 2)
	bankID := parts[0]

	if len(parts) == 2 {
		subRoute := parts[1]
		switch subRoute {
		case "retain":
			proxyToHindsight(w, "POST", "/v1/default/banks/"+bankID+"/memories", r.Body)
		case "recall":
			proxyToHindsight(w, "POST", "/v1/default/banks/"+bankID+"/memories/recall", r.Body)
		case "reflect":
			proxyToHindsightWithTimeout(w, "POST", "/v1/default/banks/"+bankID+"/reflect", r.Body, 120*time.Second)
		default:
			proxyToHindsight(w, r.Method, "/v1/default/banks/"+bankID+"/"+subRoute, r.Body)
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		proxyToHindsight(w, "GET", "/v1/default/banks/"+bankID, nil)
	case http.MethodDelete:
		proxyToHindsight(w, "DELETE", "/v1/default/banks/"+bankID, nil)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func handleRetain(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Expects {"bank_id": "...", "content": "...", "strategy": "verbatim"}
	var req map[string]interface{}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
		return
	}

	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	bankID, ok := req["bank_id"].(string)
	if !ok || bankID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bank_id is required"})
		return
	}

	proxyToHindsight(w, "POST", "/v1/default/banks/"+bankID+"/memories", strings.NewReader(string(body)))
}

func handleRecall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req map[string]interface{}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
		return
	}

	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	bankID, ok := req["bank_id"].(string)
	if !ok || bankID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bank_id is required"})
		return
	}

	proxyToHindsight(w, "POST", "/v1/default/banks/"+bankID+"/memories/recall", strings.NewReader(string(body)))
}

func handleReflect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req map[string]interface{}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
		return
	}

	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	bankID, ok := req["bank_id"].(string)
	if !ok || bankID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bank_id is required"})
		return
	}

	proxyToHindsightWithTimeout(w, "POST", "/v1/default/banks/"+bankID+"/reflect", strings.NewReader(string(body)), 120*time.Second)
}

// configPath is the persistent config file location (must be on a volume).
const configPath = "/data/config.json"

// llmConfig holds the LLM configuration fields.
type llmConfig struct {
	LLMProvider        string `json:"llm_provider"`
	LLMModel           string `json:"llm_model"`
	LLMBaseURL         string `json:"llm_base_url"`
	LLMMaxConcurrent   string `json:"llm_max_concurrent"`
	EnableObservations string `json:"enable_observations"`
	LLMAPIKey          string `json:"llm_api_key,omitempty"`
}

// loadConfig reads persisted config from disk, falling back to env vars.
func loadConfig() llmConfig {
	cfg := llmConfig{
		LLMProvider:        getEnvDefault("LLM_PROVIDER", "none"),
		LLMModel:           getEnvDefault("LLM_MODEL", ""),
		LLMBaseURL:         getEnvDefault("LLM_BASE_URL", ""),
		LLMMaxConcurrent:   getEnvDefault("LLM_MAX_CONCURRENT", "1"),
		EnableObservations:  getEnvDefault("ENABLE_OBSERVATIONS", "false"),
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return cfg
	}
	var saved llmConfig
	if json.Unmarshal(data, &saved) == nil {
		if saved.LLMProvider != "" {
			cfg.LLMProvider = saved.LLMProvider
		}
		if saved.LLMModel != "" {
			cfg.LLMModel = saved.LLMModel
		}
		if saved.LLMBaseURL != "" {
			cfg.LLMBaseURL = saved.LLMBaseURL
		}
		if saved.LLMMaxConcurrent != "" {
			cfg.LLMMaxConcurrent = saved.LLMMaxConcurrent
		}
		if saved.EnableObservations != "" {
			cfg.EnableObservations = saved.EnableObservations
		}
		if saved.LLMAPIKey != "" {
			cfg.LLMAPIKey = saved.LLMAPIKey
		}
	}
	// Map legacy provider names to valid Hindsight providers
	if cfg.LLMProvider == "openai-compatible" {
		cfg.LLMProvider = "openai"
	}
	return cfg
}

// saveConfig writes config to the persistent JSON file and generates
// the shell env file that Hindsight's entrypoint sources on startup.
func saveConfig(cfg llmConfig) error {
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return err
	}
	return writeEnvFile(cfg)
}

// envFilePath is the shell-sourceable env file read by the Hindsight entrypoint.
const envFilePath = "/data/hindsight.env"

// writeEnvFile writes a shell-sourceable file with Hindsight env vars.
func writeEnvFile(cfg llmConfig) error {
	var lines []string
	set := func(k, v string) {
		if v != "" {
			lines = append(lines, fmt.Sprintf("export %s=\"%s\"", k, v))
		}
	}
	if cfg.LLMProvider != "" && cfg.LLMProvider != "none" {
		set("HINDSIGHT_API_LLM_PROVIDER", cfg.LLMProvider)
		set("HINDSIGHT_API_LLM_MODEL", cfg.LLMModel)
		set("HINDSIGHT_API_LLM_BASE_URL", cfg.LLMBaseURL)
		set("HINDSIGHT_API_LLM_MAX_CONCURRENT", cfg.LLMMaxConcurrent)
		set("HINDSIGHT_API_ENABLE_OBSERVATIONS", cfg.EnableObservations)
		set("HINDSIGHT_API_LLM_API_KEY", cfg.LLMAPIKey)
	}
	content := strings.Join(lines, "\n") + "\n"
	log.Printf("writing env file to %s (%d vars)", envFilePath, len(lines))
	return os.WriteFile(envFilePath, []byte(content), 0644)
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := loadConfig()
		// Never send the API key back to the frontend
		cfg.LLMAPIKey = ""
		writeJSON(w, http.StatusOK, cfg)
	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
			return
		}
		var incoming llmConfig
		if err := json.Unmarshal(body, &incoming); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}

		// Merge: keep existing API key if not provided
		existing := loadConfig()
		if incoming.LLMAPIKey == "" {
			incoming.LLMAPIKey = existing.LLMAPIKey
		}
		if incoming.LLMProvider == "" {
			incoming.LLMProvider = "none"
		}
		// Map legacy provider names to valid Hindsight providers
		if incoming.LLMProvider == "openai-compatible" {
			incoming.LLMProvider = "openai"
		}
		if incoming.LLMMaxConcurrent == "" {
			incoming.LLMMaxConcurrent = "1"
		}
		if incoming.EnableObservations == "" {
			incoming.EnableObservations = "false"
		}

		if err := saveConfig(incoming); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("save config: %v", err)})
			return
		}
		log.Printf("config saved to %s", configPath)

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "Configuration saved. Disable and re-enable the extension (or restart Docker Desktop) for changes to take effect.",
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func handleRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	log.Println("restart requested — resetting Hindsight connection cache")

	// Reset cached URL so the next health-check re-discovers Hindsight.
	resetHindsightBase()

	// Give Hindsight a moment, then probe to confirm it's reachable.
	time.Sleep(2 * time.Second)
	base := probeHindsight()

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/health")
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status":  "unreachable",
			"message": fmt.Sprintf("Hindsight not reachable at %s: %v", base, err),
		})
		return
	}
	defer resp.Body.Close()

	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"message": fmt.Sprintf("Hindsight is reachable at %s (HTTP %d)", base, resp.StatusCode),
	})
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func getEnvDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
