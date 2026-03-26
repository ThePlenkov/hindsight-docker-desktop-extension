package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// secretsDir is the directory where individual secret files are stored.
// Each secret is a single file: /data/secrets/<NAME> containing the value.
// This volume is mounted read-only at /run/secrets/ in the hindsight container.
const secretsDir = "/data/secrets"

// placeholderRe matches ${type.reference} placeholders in config values.
//
// Supported forms:
//
//	${secret.NAME}        – read from /data/secrets/NAME
//	${file./path/to/file} – read contents of a file
//	${env.VAR_NAME}       – read from environment variable
var placeholderRe = regexp.MustCompile(`\$\{(secret|file|env)\.([^}]+)\}`)

// Placeholder describes a single ${type.ref} found in a config value.
type Placeholder struct {
	Full string `json:"full"` // e.g. "${secret.OPENAI_API_KEY}"
	Kind string `json:"kind"` // "secret", "file", or "env"
	Ref  string `json:"ref"`  // "OPENAI_API_KEY", "/path/to/file", "VAR"
}

// ── Resolution ─────────────────────────────────────────────────────

// resolveValue replaces all ${type.ref} placeholders in val with their
// resolved values. Returns the resolved string and any errors.
func resolveValue(val string) (string, error) {
	var errs []string
	result := placeholderRe.ReplaceAllStringFunc(val, func(match string) string {
		m := placeholderRe.FindStringSubmatch(match)
		if len(m) != 3 {
			return match
		}
		kind, ref := m[1], m[2]
		resolved, err := resolveSingle(kind, ref)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", match, err))
			return match // leave placeholder unresolved
		}
		return resolved
	})
	if len(errs) > 0 {
		return result, fmt.Errorf("unresolved: %s", strings.Join(errs, "; "))
	}
	return result, nil
}

// resolveSingle resolves a single placeholder by kind.
func resolveSingle(kind, ref string) (string, error) {
	switch kind {
	case "secret":
		return readSecret(ref)
	case "file":
		data, err := os.ReadFile(ref)
		if err != nil {
			return "", fmt.Errorf("file %q: %w", ref, err)
		}
		return strings.TrimRight(string(data), "\n\r"), nil
	case "env":
		val := os.Getenv(ref)
		if val == "" {
			return "", fmt.Errorf("env %q is empty or unset", ref)
		}
		return val, nil
	default:
		return "", fmt.Errorf("unknown placeholder kind %q", kind)
	}
}

// isPlaceholder returns true if val contains any ${...} placeholder.
func isPlaceholder(val string) bool {
	return placeholderRe.MatchString(val)
}

// extractPlaceholders returns all ${type.ref} placeholders in a string.
func extractPlaceholders(val string) []Placeholder {
	matches := placeholderRe.FindAllStringSubmatch(val, -1)
	var out []Placeholder
	for _, m := range matches {
		if len(m) == 3 {
			out = append(out, Placeholder{Full: m[0], Kind: m[1], Ref: m[2]})
		}
	}
	return out
}

// extractAllPlaceholders scans all leaf values in a YAML tree and returns
// every ${type.ref} found, keyed by the YAML dot-path where it appears.
func extractAllPlaceholders(root map[string]interface{}) map[string][]Placeholder {
	flat := flattenMap(root, "")
	result := make(map[string][]Placeholder)
	for envKey, val := range flat {
		phs := extractPlaceholders(val)
		if len(phs) > 0 {
			result[envKey] = phs
		}
	}
	return result
}

// ── Secret store CRUD ──────────────────────────────────────────────

// listSecrets returns the names of all stored secrets (filenames in secretsDir).
func listSecrets() []string {
	entries, err := os.ReadDir(secretsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		log.Printf("WARNING: listSecrets: %v", err)
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

// readSecret reads a single secret by name.
func readSecret(name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(secretsDir, name))
	if err != nil {
		return "", fmt.Errorf("secret %q: %w", name, err)
	}
	return strings.TrimRight(string(data), "\n\r"), nil
}

// writeSecret stores a secret as an individual file.
// Directory is 0755 and files are 0644 so the hindsight container (uid 1000)
// can read them through the read-only volume mount.
func writeSecret(name, value string) error {
	if err := os.MkdirAll(secretsDir, 0755); err != nil {
		return fmt.Errorf("mkdir secrets: %w", err)
	}
	path := filepath.Join(secretsDir, name)
	return os.WriteFile(path, []byte(value), 0644)
}

// deleteSecret removes a secret file.
func deleteSecret(name string) error {
	path := filepath.Join(secretsDir, name)
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// secretExists checks if a secret has been set.
func secretExists(name string) bool {
	_, err := os.Stat(filepath.Join(secretsDir, name))
	return err == nil
}

// ── Secret-aware env file generation ───────────────────────────────

// writeSecretsFromYAML scans the flattened YAML for ${secret.NAME} placeholders
// and writes the resolved HINDSIGHT_API_* env vars as individual secret files
// in /data/secrets/. Returns the set of env var keys that were written as secrets
// (so writeEnvFileFromYAML can skip them).
func writeSecretsFromYAML(root map[string]interface{}) (map[string]bool, error) {
	flat := flattenMap(root, "")
	secretKeys := make(map[string]bool)

	for envKey, val := range flat {
		if !strings.HasPrefix(envKey, "HINDSIGHT_") {
			continue
		}
		if !isPlaceholder(val) {
			continue
		}
		resolved, err := resolveValue(val)
		if err != nil {
			log.Printf("WARNING: secret resolution for %s: %v", envKey, err)
			continue // don't write unresolvable placeholders as secret files
		}
		if resolved == "" || resolved == val {
			continue // placeholder couldn't be resolved
		}
		if err := writeSecret(envKey, resolved); err != nil {
			return secretKeys, fmt.Errorf("write secret %s: %w", envKey, err)
		}
		secretKeys[envKey] = true
	}
	return secretKeys, nil
}

// resolveOverrides takes a flat env-var map and resolves any ${...} placeholders.
// Used by handleApplyConfig when PATCHing bank configs at runtime.
func resolveOverrides(overrides map[string]interface{}) map[string]interface{} {
	resolved := make(map[string]interface{})
	for k, v := range overrides {
		s, ok := v.(string)
		if !ok {
			resolved[k] = v
			continue
		}
		if isPlaceholder(s) {
			r, err := resolveValue(s)
			if err != nil {
				log.Printf("WARNING: resolve override %s: %v", k, err)
				// Skip unresolvable — don't push raw placeholder to Hindsight
				continue
			}
			resolved[k] = r
		} else {
			resolved[k] = v
		}
	}
	return resolved
}

// ── Auto-migration: hardcoded secrets → placeholders ───────────────

// sensitiveYAMLPaths maps YAML dot-paths that typically hold secrets to the
// canonical secret name to use. When a raw (non-placeholder) value is found
// at one of these paths, migrateHardcodedSecrets creates a secret and
// rewrites the YAML value to ${secret.<name>}.
var sensitiveYAMLPaths = map[string]string{
	"hindsight.api.llm.api_key":         "LLM_API_KEY",
	"hindsight.api.retain.llm.api_key":  "RETAIN_LLM_API_KEY",
	"hindsight.api.reflect.llm.api_key": "REFLECT_LLM_API_KEY",
	"hindsight.api.consolidation.llm.api_key": "CONSOLIDATION_LLM_API_KEY",
}

// migrateHardcodedSecrets scans the YAML tree for raw (non-placeholder)
// values at known sensitive paths, stores them in the secret store, and
// replaces the YAML value with a ${secret.NAME} placeholder.
// Returns true if any values were migrated (caller should re-save the YAML).
func migrateHardcodedSecrets(root map[string]interface{}) bool {
	// Ensure secrets dir has correct permissions (fix for early builds that used 0700)
	if info, err := os.Stat(secretsDir); err == nil && info.IsDir() {
		_ = os.Chmod(secretsDir, 0755)
		// Also fix file permissions for any existing secrets
		entries, _ := os.ReadDir(secretsDir)
		for _, e := range entries {
			if !e.IsDir() {
				_ = os.Chmod(filepath.Join(secretsDir, e.Name()), 0644)
			}
		}
	}

	migrated := false
	for yamlPath, secretName := range sensitiveYAMLPaths {
		val := getYAMLPath(root, yamlPath)
		if val == "" || isPlaceholder(val) {
			continue
		}
		// Raw value found — migrate it
		if err := writeSecret(secretName, val); err != nil {
			log.Printf("WARNING: migrate secret %s: %v", secretName, err)
			continue
		}
		placeholder := fmt.Sprintf("${secret.%s}", secretName)
		setYAMLPath(root, yamlPath, placeholder)
		log.Printf("migrated hardcoded %s → %s", yamlPath, placeholder)
		migrated = true
	}
	return migrated
}
