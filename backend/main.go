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
	mux.HandleFunc("/config", handleConfig)

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
	base := getHindsightBase()
	url := base + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("create request: %v", err)})
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
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
	resp, err := client.Get(base + "/api/v1/banks")
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
	var banks []interface{}
	if json.Unmarshal(body, &banks) == nil {
		status["hindsight_ready"] = true
		status["bank_count"] = len(banks)
		status["banks"] = banks
	} else {
		status["hindsight_ready"] = true
		status["banks_raw"] = string(body)
	}

	writeJSON(w, http.StatusOK, status)
}

func handleBanks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		proxyToHindsight(w, "GET", "/api/v1/banks", nil)
	case http.MethodPost:
		proxyToHindsight(w, "POST", "/api/v1/banks", r.Body)
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
			proxyToHindsight(w, "POST", "/api/v1/banks/"+bankID+"/retain", r.Body)
		case "recall":
			proxyToHindsight(w, "POST", "/api/v1/banks/"+bankID+"/recall", r.Body)
		default:
			proxyToHindsight(w, r.Method, "/api/v1/banks/"+bankID+"/"+subRoute, r.Body)
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		proxyToHindsight(w, "GET", "/api/v1/banks/"+bankID, nil)
	case http.MethodDelete:
		proxyToHindsight(w, "DELETE", "/api/v1/banks/"+bankID, nil)
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

	proxyToHindsight(w, "POST", "/api/v1/banks/"+bankID+"/retain", strings.NewReader(string(body)))
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

	proxyToHindsight(w, "POST", "/api/v1/banks/"+bankID+"/recall", strings.NewReader(string(body)))
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		config := map[string]string{
			"llm_provider":       getEnvDefault("LLM_PROVIDER", "none"),
			"llm_model":          getEnvDefault("LLM_MODEL", ""),
			"llm_base_url":       getEnvDefault("LLM_BASE_URL", ""),
			"llm_max_concurrent": getEnvDefault("LLM_MAX_CONCURRENT", "1"),
			"enable_observations": getEnvDefault("ENABLE_OBSERVATIONS", "false"),
		}
		writeJSON(w, http.StatusOK, config)
	case http.MethodPost:
		// Config updates require restarting the Hindsight container
		// The UI should use Docker Desktop SDK to update compose env vars
		writeJSON(w, http.StatusOK, map[string]string{
			"message": "Config updates require restarting the Hindsight service. Use Docker Desktop to update environment variables in the compose file.",
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
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
