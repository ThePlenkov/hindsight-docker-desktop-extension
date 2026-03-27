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
	mux.HandleFunc("/config/yaml", handleConfigYAML)
	mux.HandleFunc("/apply-config", handleApplyConfig)
	mux.HandleFunc("/secrets", handleSecrets)
	mux.HandleFunc("/secrets/", handleSecretByName)
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
	yamlData, err := loadYAMLRaw()
	if err != nil {
		log.Printf("WARNING: failed to load YAML config: %v", err)
	} else if yamlData != nil {
		root, err := parseYAML(yamlData)
		if err != nil {
			log.Printf("WARNING: failed to parse YAML config: %v", err)
		} else {
			// Auto-migrate any hardcoded secrets to ${secret.*} placeholders
			if migrateHardcodedSecrets(root) {
				log.Println("migrated hardcoded secrets to placeholders, re-saving YAML")
				if err := saveYAMLMap(root); err != nil {
					log.Printf("WARNING: failed to save migrated YAML: %v", err)
				}
			}

			if err := writeEnvFileFromYAML(root); err != nil {
				log.Printf("WARNING: failed to write env file: %v", err)
			} else {
				provider := getYAMLPath(root, "hindsight.api.llm.provider")
				model := getYAMLPath(root, "hindsight.api.llm.model")
				log.Printf("wrote hindsight.env from YAML: provider=%s model=%s", provider, model)
			}
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

	// Build a MemoryItem from the flat request fields
	item := map[string]interface{}{
		"content": req["content"],
	}
	if v, ok := req["context"]; ok {
		item["context"] = v
	}
	if v, ok := req["tags"]; ok {
		item["tags"] = v
	}
	if v, ok := req["metadata"]; ok {
		item["metadata"] = v
	}
	if v, ok := req["timestamp"]; ok {
		item["timestamp"] = v
	}

	// Wrap into the Hindsight RetainRequest format: { items: [...] }
	retainReq := map[string]interface{}{
		"items": []interface{}{item},
	}
	retainBody, err := json.Marshal(retainReq)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to build retain request"})
		return
	}

	proxyToHindsight(w, "POST", "/v1/default/banks/"+bankID+"/memories", strings.NewReader(string(retainBody)))
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

// configPath is the legacy config file location (used for migration).
const configPath = "/data/config.json"

// llmConfig holds the basic config fields for the card-based UI.
// This is a subset of what the YAML config supports.
type llmConfig struct {
	LLMProvider        string `json:"llm_provider"`
	LLMModel           string `json:"llm_model"`
	LLMBaseURL         string `json:"llm_base_url"`
	LLMMaxConcurrent   string `json:"llm_max_concurrent"`
	EnableObservations string `json:"enable_observations"`
	LLMAPIKey          string `json:"llm_api_key,omitempty"`
	// Database
	DatabaseURL        string `json:"database_url,omitempty"`
	// Monitoring / OpenTelemetry
	OtelTracesEnabled  string `json:"otel_traces_enabled"`
	OtelEndpoint       string `json:"otel_endpoint"`
	OtelHeaders        string `json:"otel_headers"`
	OtelServiceName    string `json:"otel_service_name"`
	OtelEnvironment    string `json:"otel_environment"`
}

// envFilePath is the shell-sourceable env file read by the Hindsight entrypoint.
const envFilePath = "/data/hindsight.env"

// loadConfig loads the config from YAML (migrating from JSON if needed)
// and returns the basic fields for the card-based UI.
func loadConfig() llmConfig {
	yamlData, err := loadYAMLRaw()
	if err != nil {
		log.Printf("WARNING: loadConfig: %v", err)
		return llmConfig{LLMProvider: "none", LLMMaxConcurrent: "1", EnableObservations: "false", OtelTracesEnabled: "false"}
	}
	root, err := parseYAML(yamlData)
	if err != nil {
		log.Printf("WARNING: loadConfig parse: %v", err)
		return llmConfig{LLMProvider: "none", LLMMaxConcurrent: "1", EnableObservations: "false", OtelTracesEnabled: "false"}
	}
	return yamlToLegacy(root)
}

// handleConfig serves the basic card-based UI config (GET/POST JSON).
// This reads/writes through the YAML config, preserving advanced settings.
func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := loadConfig()
		// Never send secrets back to the frontend
		cfg.LLMAPIKey = ""
		cfg.DatabaseURL = ""
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

		// Load existing YAML to preserve advanced settings
		yamlData, err := loadYAMLRaw()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("load config: %v", err)})
			return
		}
		root, err := parseYAML(yamlData)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("parse config: %v", err)})
			return
		}

		// Merge: keep existing secrets if not provided in incoming
		existing := yamlToLegacy(root)
		if incoming.LLMAPIKey == "" {
			incoming.LLMAPIKey = existing.LLMAPIKey
		}
		if incoming.DatabaseURL == "" {
			incoming.DatabaseURL = existing.DatabaseURL
		}
		if incoming.LLMProvider == "" {
			incoming.LLMProvider = "none"
		}
		if incoming.LLMProvider == "openai-compatible" {
			incoming.LLMProvider = "openai"
		}
		if incoming.LLMMaxConcurrent == "" {
			incoming.LLMMaxConcurrent = "1"
		}
		if incoming.EnableObservations == "" {
			incoming.EnableObservations = "false"
		}
		if incoming.OtelTracesEnabled == "" {
			incoming.OtelTracesEnabled = "false"
		}

		// Update the YAML tree with basic fields (preserves advanced settings)
		legacyToYAML(root, incoming)

		// Auto-migrate any raw secrets that slipped through
		migrateHardcodedSecrets(root)

		if err := saveYAMLMap(root); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("save config: %v", err)})
			return
		}
		log.Printf("config saved via basic UI")

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "Configuration saved.",
		})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleConfigYAML serves the YAML config wrapped in JSON for the DD extension SDK.
// GET returns {"yaml": "<yaml text>"}; POST accepts a JSON-encoded string body.
func handleConfigYAML(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		yamlData, err := loadYAMLRaw()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("load YAML: %v", err)})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"yaml": string(yamlData)})

	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
			return
		}

		// The DD extension SDK JSON-encodes the body. Try to unwrap a JSON string first.
		var yamlText string
		if err := json.Unmarshal(body, &yamlText); err != nil {
			// Fallback: treat body as raw YAML text (e.g. from curl)
			yamlText = string(body)
		}

		// Validate: must be parseable YAML
		root, err := parseYAML([]byte(yamlText))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid YAML: %v", err)})
			return
		}

		// Auto-migrate any raw secrets in the YAML
		if migrateHardcodedSecrets(root) {
			log.Println("migrated hardcoded secrets in YAML editor save")
			if err := saveYAMLMap(root); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("save YAML: %v", err)})
				return
			}
		} else {
			if err := saveYAMLRaw([]byte(yamlText)); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("save YAML: %v", err)})
				return
			}
		}
		log.Printf("config saved via YAML editor")

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "YAML configuration saved and env file regenerated.",
		})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleApplyConfig pushes the current config to all existing banks
// via the Hindsight per-bank config PATCH API. Uses ALL env vars from
// the flattened YAML — not just the basic LLM fields.
func handleApplyConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Load and flatten the YAML config
	yamlData, err := loadYAMLRaw()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("load config: %v", err)})
		return
	}
	root, err := parseYAML(yamlData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("parse config: %v", err)})
		return
	}

	// Build the overrides from ALL HINDSIGHT_API_* vars
	overrides := flattenYAMLToOverrides(root)

	// Resolve any ${secret.*}, ${file.*}, ${env.*} placeholders before PATCHing
	overrides = resolveOverrides(overrides)

	// Fetch the list of banks
	base := getHindsightBase()
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(base + "/v1/default/banks")
	if err != nil {
		resetHindsightBase()
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("cannot reach Hindsight to list banks: %v", err),
		})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var wrapped map[string]json.RawMessage
	var bankIDs []string
	if json.Unmarshal(body, &wrapped) == nil {
		if banksRaw, ok := wrapped["banks"]; ok {
			var banks []map[string]interface{}
			if json.Unmarshal(banksRaw, &banks) == nil {
				for _, b := range banks {
					if id, ok := b["bank_id"].(string); ok {
						bankIDs = append(bankIDs, id)
					}
				}
			}
		}
	}

	patchBody, _ := json.Marshal(map[string]interface{}{"config": overrides})

	var applied []string
	var errors []string
	for _, bankID := range bankIDs {
		req, _ := http.NewRequest("PATCH", base+"/v1/default/banks/"+bankID+"/config", strings.NewReader(string(patchBody)))
		req.Header.Set("Content-Type", "application/json")
		pResp, err := client.Do(req)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", bankID, err))
			continue
		}
		pResp.Body.Close()
		if pResp.StatusCode >= 200 && pResp.StatusCode < 300 {
			applied = append(applied, bankID)
		} else {
			errors = append(errors, fmt.Sprintf("%s: HTTP %d", bankID, pResp.StatusCode))
		}
	}

	result := map[string]interface{}{
		"applied_to": applied,
		"bank_count": len(bankIDs),
	}
	if len(errors) > 0 {
		result["errors"] = errors
	}

	// Check if settings that need restart were changed
	cfg := yamlToLegacy(root)
	needsRestart := false
	if cfg.OtelTracesEnabled == "true" {
		needsRestart = true
	}
	if cfg.DatabaseURL != "" {
		needsRestart = true
	}
	if needsRestart {
		result["needs_restart"] = true
	}

	log.Printf("apply-config: pushed config to %d/%d banks (%d env vars)", len(applied), len(bankIDs), len(overrides))
	writeJSON(w, http.StatusOK, result)
}

// handleSecrets manages the secret store.
// GET  /secrets          — list all secrets (names + metadata, NOT values)
// POST /secrets          — bulk upsert: {"secrets": {"NAME": "value", ...}}
func handleSecrets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// Return only secrets referenced as ${secret.*} in the YAML config.
		type secretInfo struct {
			Name   string `json:"name"`
			Exists bool   `json:"exists"`
		}
		var infos []secretInfo
		yamlData, _ := loadYAMLRaw()
		if yamlData != nil {
			root, _ := parseYAML(yamlData)
			if root != nil {
				seen := make(map[string]bool)
				for _, phs := range extractAllPlaceholders(root) {
					for _, ph := range phs {
						if ph.Kind == "secret" && !seen[ph.Ref] {
							seen[ph.Ref] = true
							infos = append(infos, secretInfo{
								Name:   ph.Ref,
								Exists: secretExists(ph.Ref),
							})
						}
					}
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"secrets": infos})

	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
			return
		}
		var req struct {
			Secrets map[string]string `json:"secrets"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		var saved []string
		var errs []string
		for name, value := range req.Secrets {
			if value == "" {
				if err := deleteSecret(name); err != nil {
					errs = append(errs, fmt.Sprintf("%s: %v", name, err))
				}
				continue
			}
			if err := writeSecret(name, value); err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", name, err))
			} else {
				saved = append(saved, name)
			}
		}
		result := map[string]interface{}{"saved": saved}
		if len(errs) > 0 {
			result["errors"] = errs
		}
		log.Printf("secrets: saved %d, errors %d", len(saved), len(errs))
		writeJSON(w, http.StatusOK, result)

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleSecretByName manages individual secrets.
// PUT    /secrets/{name} — set a single secret
// DELETE /secrets/{name} — delete a single secret
func handleSecretByName(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/secrets/")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "secret name required"})
		return
	}

	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
			return
		}
		var req struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if err := writeSecret(name, req.Value); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("write secret: %v", err)})
			return
		}
		log.Printf("secret %q saved", name)
		writeJSON(w, http.StatusOK, map[string]string{"message": fmt.Sprintf("secret %q saved", name)})

	case http.MethodDelete:
		if err := deleteSecret(name); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("delete secret: %v", err)})
			return
		}
		log.Printf("secret %q deleted", name)
		writeJSON(w, http.StatusOK, map[string]string{"message": fmt.Sprintf("secret %q deleted", name)})

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
