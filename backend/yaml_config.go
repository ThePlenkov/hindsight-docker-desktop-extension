package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const yamlConfigPath = "/data/hindsight.yaml"

// defaultYAMLTemplate is the initial config written on first run.
// Comments guide users through all available options.
const defaultYAMLTemplate = `# Hindsight Configuration
# ─────────────────────────────────────────────────────────────────────
# Nested YAML keys automatically map to HINDSIGHT_API_* env vars.
# Example:  hindsight.api.llm.provider  →  HINDSIGHT_API_LLM_PROVIDER
#
# Docs:        https://hindsight.vectorize.io/developer/configuration
# Benchmarks:  https://benchmarks.hindsight.vectorize.io/
# ─────────────────────────────────────────────────────────────────────

hindsight:
  api:
    # ── Global LLM (fallback for retain / reflect / consolidation) ──
    llm:
      provider: "mock"
      # model: "gpt-4o-mini"
      # base_url: "http://host.docker.internal:4000"
      # api_key: ""
      max_concurrent: "1"

    # ── Per-operation LLM overrides ──────────────────────────────────
    # Retain: fact extraction — benefits from structured-output models
    # Top models: openai/gpt-oss-20b (Groq), gpt-4.1-nano (OpenAI)
    # retain:
    #   llm:
    #     provider: "groq"
    #     model: "openai/gpt-oss-20b"
    #     api_key: "gsk_xxx"
    #   extraction_mode: "concise"

    # Reflect: reasoning/synthesis — benefits from fast, capable models
    # Top models: openai/gpt-oss-120b (Groq), gemini-2.5-flash-lite
    # reflect:
    #   llm:
    #     provider: "groq"
    #     model: "openai/gpt-oss-120b"
    #     api_key: "gsk_xxx"

    # Consolidation: observation synthesis
    # consolidation:
    #   llm:
    #     provider: "groq"
    #     model: "openai/gpt-oss-20b"

    # ── Embeddings ───────────────────────────────────────────────────
    # embeddings:
    #   provider: "local"               # local, openai, cohere, tei, litellm
    #   local_model: "BAAI/bge-small-en-v1.5"

    # ── Reranker ─────────────────────────────────────────────────────
    # reranker:
    #   provider: "local"               # local, cohere, litellm, rrf
    #   local_model: "cross-encoder/ms-marco-MiniLM-L-6-v2"

    # ── Observations ─────────────────────────────────────────────────
    enable_observations: "false"

    # ── Retain pipeline tuning ───────────────────────────────────────
    # retain:
    #   extraction_mode: "concise"      # concise, verbose, verbatim, chunks, custom
    #   chunk_size: "3000"
    #   extract_causal_links: "true"
    #   mission: "Focus on technical decisions and architecture choices."

    # ── Reflect tuning ───────────────────────────────────────────────
    # reflect:
    #   max_iterations: "10"
    #   max_context_tokens: "100000"
    #   wall_timeout: "300"

    # ── Disposition (1=low, 5=high) ──────────────────────────────────
    # disposition:
    #   skepticism: "3"
    #   literalism: "3"
    #   empathy: "3"

    # ── Database ─────────────────────────────────────────────────────
    # database:
    #   url: "postgresql://user:pass@host:5432/hindsight"

    # ── Monitoring ───────────────────────────────────────────────────
    # otel:
    #   traces_enabled: "true"
    #   exporter:
    #     otlp:
    #       endpoint: "http://host.docker.internal:4318"
    #       headers: ""
    #   service_name: "hindsight-api"
    #   deployment_environment: "development"

    # ── Server ───────────────────────────────────────────────────────
    # log_level: "info"
    # workers: "1"
    skip_llm_verification: "true"
    lazy_reranker: "true"
`

// flattenMap recursively flattens a nested YAML map to SCREAMING_SNAKE env vars.
//
//	{"hindsight": {"api": {"llm": {"provider": "openai"}}}}
//	→ {"HINDSIGHT_API_LLM_PROVIDER": "openai"}
func flattenMap(data map[string]interface{}, prefix string) map[string]string {
	result := make(map[string]string)
	for key, val := range data {
		envKey := strings.ToUpper(key)
		if prefix != "" {
			envKey = prefix + "_" + envKey
		}
		switch v := val.(type) {
		case map[string]interface{}:
			for k, v2 := range flattenMap(v, envKey) {
				result[k] = v2
			}
		case map[interface{}]interface{}:
			m := make(map[string]interface{})
			for mk, mv := range v {
				m[fmt.Sprintf("%v", mk)] = mv
			}
			for k, v2 := range flattenMap(m, envKey) {
				result[k] = v2
			}
		default:
			result[envKey] = fmt.Sprintf("%v", val)
		}
	}
	return result
}

// getYAMLPath reads a value from a nested map by dot-separated path.
// e.g., getYAMLPath(root, "hindsight.api.llm.provider") → "openai"
func getYAMLPath(root map[string]interface{}, path string) string {
	parts := strings.Split(path, ".")
	current := root
	for i, part := range parts {
		v, ok := current[part]
		if !ok {
			return ""
		}
		if i == len(parts)-1 {
			return fmt.Sprintf("%v", v)
		}
		switch m := v.(type) {
		case map[string]interface{}:
			current = m
		case map[interface{}]interface{}:
			current = make(map[string]interface{})
			for mk, mv := range m {
				current[fmt.Sprintf("%v", mk)] = mv
			}
		default:
			return ""
		}
	}
	return ""
}

// setYAMLPath sets a value in a nested map, creating intermediates as needed.
func setYAMLPath(root map[string]interface{}, path string, value interface{}) {
	parts := strings.Split(path, ".")
	current := root
	for _, part := range parts[:len(parts)-1] {
		if next, ok := current[part]; ok {
			if m, ok := next.(map[string]interface{}); ok {
				current = m
			} else {
				m := make(map[string]interface{})
				current[part] = m
				current = m
			}
		} else {
			m := make(map[string]interface{})
			current[part] = m
			current = m
		}
	}
	last := parts[len(parts)-1]
	if value == nil || value == "" {
		delete(current, last)
	} else {
		current[last] = value
	}
}

// ── Load / Save ────────────────────────────────────────────────────

// loadYAMLRaw returns the raw YAML bytes from disk.
// Returns the default template if no file exists.
func loadYAMLRaw() ([]byte, error) {
	data, err := os.ReadFile(yamlConfigPath)
	if err == nil {
		return data, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	// Try migrating from legacy config.json
	if migrated := migrateFromJSON(); migrated != nil {
		return migrated, nil
	}
	return []byte(defaultYAMLTemplate), nil
}

// parseYAML parses YAML bytes into a nested map.
func parseYAML(data []byte) (map[string]interface{}, error) {
	var root map[string]interface{}
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}
	if root == nil {
		root = make(map[string]interface{})
	}
	return root, nil
}

// saveYAMLRaw writes raw YAML bytes to disk and regenerates hindsight.env.
func saveYAMLRaw(data []byte) error {
	if err := os.MkdirAll(filepath.Dir(yamlConfigPath), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	if err := os.WriteFile(yamlConfigPath, data, 0644); err != nil {
		return err
	}
	// Regenerate the env file from the parsed YAML
	root, err := parseYAML(data)
	if err != nil {
		return err
	}
	return writeEnvFileFromYAML(root)
}

// saveYAMLMap marshals a map to YAML and saves it.
func saveYAMLMap(root map[string]interface{}) error {
	data, err := yaml.Marshal(root)
	if err != nil {
		return fmt.Errorf("marshal YAML: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(yamlConfigPath), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	if err := os.WriteFile(yamlConfigPath, data, 0644); err != nil {
		return err
	}
	return writeEnvFileFromYAML(root)
}

// writeEnvFileFromYAML flattens the YAML tree and writes hindsight.env.
func writeEnvFileFromYAML(root map[string]interface{}) error {
	envVars := flattenMap(root, "")

	// Filter to HINDSIGHT_API_* only (ignore any stray keys)
	var lines []string
	for k, v := range envVars {
		if strings.HasPrefix(k, "HINDSIGHT_") && v != "" {
			lines = append(lines, fmt.Sprintf("export %s=%q", k, v))
		}
	}
	sort.Strings(lines) // deterministic output

	content := strings.Join(lines, "\n") + "\n"
	log.Printf("writing env file to %s (%d vars)", envFilePath, len(lines))
	return os.WriteFile(envFilePath, []byte(content), 0644)
}

// flattenYAMLToOverrides returns the HINDSIGHT_API_* env vars from the YAML tree.
func flattenYAMLToOverrides(root map[string]interface{}) map[string]interface{} {
	flat := flattenMap(root, "")
	overrides := make(map[string]interface{})
	for k, v := range flat {
		if strings.HasPrefix(k, "HINDSIGHT_API_") && v != "" {
			overrides[k] = v
		}
	}
	return overrides
}

// ── Legacy migration ───────────────────────────────────────────────

// legacyPathMapping maps old llmConfig JSON fields to YAML paths.
var legacyPathMapping = map[string]string{
	"llm_provider":        "hindsight.api.llm.provider",
	"llm_model":           "hindsight.api.llm.model",
	"llm_base_url":        "hindsight.api.llm.base_url",
	"llm_max_concurrent":  "hindsight.api.llm.max_concurrent",
	"llm_api_key":         "hindsight.api.llm.api_key",
	"enable_observations":  "hindsight.api.enable_observations",
	"database_url":         "hindsight.api.database.url",
	"otel_traces_enabled":  "hindsight.api.otel.traces_enabled",
	"otel_endpoint":        "hindsight.api.otel.exporter.otlp.endpoint",
	"otel_headers":         "hindsight.api.otel.exporter.otlp.headers",
	"otel_service_name":    "hindsight.api.otel.service_name",
	"otel_environment":     "hindsight.api.otel.deployment_environment",
}

// migrateFromJSON reads legacy config.json and converts to YAML bytes.
// Returns nil if no config.json exists.
func migrateFromJSON() []byte {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	var flat map[string]interface{}
	if err := json.Unmarshal(data, &flat); err != nil {
		log.Printf("WARNING: cannot parse legacy config.json: %v", err)
		return nil
	}

	root := make(map[string]interface{})
	// Set the skip/lazy defaults
	setYAMLPath(root, "hindsight.api.skip_llm_verification", "true")
	setYAMLPath(root, "hindsight.api.lazy_reranker", "true")

	for jsonKey, yamlPath := range legacyPathMapping {
		if v, ok := flat[jsonKey]; ok {
			s := fmt.Sprintf("%v", v)
			if s != "" {
				setYAMLPath(root, yamlPath, s)
			}
		}
	}

	yamlBytes, err := yaml.Marshal(root)
	if err != nil {
		log.Printf("WARNING: cannot marshal migrated config: %v", err)
		return nil
	}

	// Save the migrated YAML
	if err := os.MkdirAll(filepath.Dir(yamlConfigPath), 0755); err == nil {
		if err := os.WriteFile(yamlConfigPath, yamlBytes, 0644); err == nil {
			log.Printf("migrated config.json → hindsight.yaml")
		}
	}
	return yamlBytes
}

// yamlToLegacy extracts known fields from the YAML tree into an llmConfig
// for backward compatibility with the basic UI.
func yamlToLegacy(root map[string]interface{}) llmConfig {
	g := func(path string) string { return getYAMLPath(root, path) }
	cfg := llmConfig{
		LLMProvider:        g("hindsight.api.llm.provider"),
		LLMModel:           g("hindsight.api.llm.model"),
		LLMBaseURL:         g("hindsight.api.llm.base_url"),
		LLMMaxConcurrent:   g("hindsight.api.llm.max_concurrent"),
		EnableObservations:  g("hindsight.api.enable_observations"),
		LLMAPIKey:          g("hindsight.api.llm.api_key"),
		DatabaseURL:        g("hindsight.api.database.url"),
		OtelTracesEnabled:  g("hindsight.api.otel.traces_enabled"),
		OtelEndpoint:       g("hindsight.api.otel.exporter.otlp.endpoint"),
		OtelHeaders:        g("hindsight.api.otel.exporter.otlp.headers"),
		OtelServiceName:    g("hindsight.api.otel.service_name"),
		OtelEnvironment:    g("hindsight.api.otel.deployment_environment"),
	}
	// Apply defaults
	if cfg.LLMProvider == "" {
		cfg.LLMProvider = "none"
	}
	if cfg.LLMMaxConcurrent == "" {
		cfg.LLMMaxConcurrent = "1"
	}
	if cfg.EnableObservations == "" {
		cfg.EnableObservations = "false"
	}
	if cfg.OtelTracesEnabled == "" {
		cfg.OtelTracesEnabled = "false"
	}
	// Map legacy provider names
	if cfg.LLMProvider == "openai-compatible" {
		cfg.LLMProvider = "openai"
	}
	return cfg
}

// legacyToYAML merges llmConfig fields into an existing YAML tree.
func legacyToYAML(root map[string]interface{}, cfg llmConfig) {
	set := func(path, value string) {
		if value != "" && value != "none" {
			setYAMLPath(root, path, value)
		} else {
			// Clear the path if empty/none
			setYAMLPath(root, path, nil)
		}
	}
	// LLM provider "none" means no provider — still store it so the YAML
	// reflects the user's intent to disable LLM.
	if cfg.LLMProvider == "none" || cfg.LLMProvider == "" {
		setYAMLPath(root, "hindsight.api.llm.provider", "mock")
	} else {
		setYAMLPath(root, "hindsight.api.llm.provider", cfg.LLMProvider)
	}
	setYAMLPath(root, "hindsight.api.llm.model", cfg.LLMModel)
	setYAMLPath(root, "hindsight.api.llm.base_url", cfg.LLMBaseURL)
	setYAMLPath(root, "hindsight.api.llm.max_concurrent", cfg.LLMMaxConcurrent)
	setYAMLPath(root, "hindsight.api.llm.api_key", cfg.LLMAPIKey)
	set("hindsight.api.enable_observations", cfg.EnableObservations)
	set("hindsight.api.database.url", cfg.DatabaseURL)
	if cfg.OtelTracesEnabled == "true" {
		setYAMLPath(root, "hindsight.api.otel.traces_enabled", cfg.OtelTracesEnabled)
		setYAMLPath(root, "hindsight.api.otel.exporter.otlp.endpoint", cfg.OtelEndpoint)
		setYAMLPath(root, "hindsight.api.otel.exporter.otlp.headers", cfg.OtelHeaders)
		setYAMLPath(root, "hindsight.api.otel.service_name", cfg.OtelServiceName)
		setYAMLPath(root, "hindsight.api.otel.deployment_environment", cfg.OtelEnvironment)
	}
}
