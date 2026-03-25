# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests",
# ]
# ///
"""
Ingest Devin session summaries into Hindsight memory bank.

Reads session transcript files, extracts <summary> sections (if present),
and sends them to the Hindsight retain API for memory extraction.

For files without summaries, extracts user messages as context.
"""

import os
import re
import sys
import json
import time
import requests
from pathlib import Path

HINDSIGHT_URL = "http://localhost:8888"
BANK_ID = "devin"
RETAIN_URL = f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/memories"

# Directories to scan
WINDOWS_DIR = Path(os.path.expandvars(r"%APPDATA%\devin\cli\summaries"))

def get_wsl_path():
    """Get the WSL summaries path accessible from Windows."""
    wsl_path = Path(r"\\wsl.localhost\Ubuntu\home\pplenkov\.local\share\devin\cli\summaries")
    if wsl_path.exists():
        return wsl_path
    wsl_path = Path(r"\\wsl$\Ubuntu\home\pplenkov\.local\share\devin\cli\summaries")
    if wsl_path.exists():
        return wsl_path
    return None

def extract_summary(content: str) -> str | None:
    """Extract the <summary>...</summary> section from a file."""
    match = re.search(r'<summary>(.*?)</summary>', content, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None

def extract_user_messages(content: str, max_chars: int = 15000) -> str:
    """Extract user messages from the transcript for files without summaries."""
    messages = []
    parts = re.split(r'=== MESSAGE \d+ - User ===\n', content)
    for part in parts[1:]:
        end = part.find('=== MESSAGE')
        if end > 0:
            msg = part[:end].strip()
        else:
            msg = part.strip()
        if len(msg) > 50:
            messages.append(msg)

    combined = "\n\n---\n\n".join(messages)
    if len(combined) > max_chars:
        combined = combined[:max_chars] + "\n\n[...truncated...]"
    return combined

def extract_session_context(content: str) -> str:
    """Extract workspace/project context from the transcript."""
    context_parts = []

    match = re.search(r'Current workspace directories.*?:\s*\n\s*(.*?)(?:\n\n|\n===)', content, re.DOTALL)
    if match:
        context_parts.append(f"Workspace: {match.group(1).strip()}")

    git_info = ""
    match = re.search(r'<git_status>(.*?)</git_status>', content, re.DOTALL)
    if match:
        git_info = match.group(1).strip()
        repo_match = re.search(r'Git root: (.*)', git_info)
        branch_match = re.search(r'Current branch: (.*)', git_info)
        if repo_match:
            context_parts.append(f"Repo: {repo_match.group(1).strip()}")
        if branch_match:
            context_parts.append(f"Branch: {branch_match.group(1).strip()}")

    commits = re.findall(r'([a-f0-9]{7}) (.+)', git_info)
    if commits:
        context_parts.append("Recent commits: " + "; ".join(f"{h} {m}" for h, m in commits[:5]))

    return " | ".join(context_parts) if context_parts else "Devin CLI coding session"

def retain_memory(content: str, context: str, document_id: str):
    """Send content to Hindsight retain API using items array format."""
    payload = {
        "items": [
            {
                "content": content,
                "context": context,
                "document_id": document_id,
            }
        ],
        "async": True,  # Process in background for speed
    }

    try:
        resp = requests.post(RETAIN_URL, json=payload, timeout=120)
        if resp.status_code == 200:
            result = resp.json()
            return True, result
        else:
            return False, f"HTTP {resp.status_code}: {resp.text[:300]}"
    except requests.exceptions.Timeout:
        return False, "Request timed out (120s)"
    except Exception as e:
        return False, str(e)

def process_file(filepath: Path, source_label: str):
    """Process a single summary file."""
    session_id = filepath.stem

    try:
        content = filepath.read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        return False, f"Read error: {e}"

    summary = extract_summary(content)
    if summary:
        text_to_retain = summary
        doc_type = "summary"
    else:
        text_to_retain = extract_user_messages(content)
        doc_type = "transcript"
        if not text_to_retain or len(text_to_retain) < 100:
            return False, "No meaningful content to retain"

    context = extract_session_context(content)
    context = f"{source_label} | {doc_type} | {context}"

    document_id = f"devin-session-{session_id}"

    return retain_memory(text_to_retain, context, document_id)

def main():
    log = open("ingest_log.txt", "w", encoding="utf-8")
    def out(msg, end="\n"):
        log.write(msg + end)
        log.flush()
        print(msg, end=end)

    out(f"Hindsight Retain URL: {RETAIN_URL}")
    out("")

    # Check Hindsight health
    try:
        resp = requests.get(f"{HINDSIGHT_URL}/health", timeout=5)
        if resp.status_code != 200:
            out(f"ERROR: Hindsight health check failed: {resp.status_code}")
            sys.exit(1)
        out("Hindsight is healthy.")
    except Exception as e:
        out(f"ERROR: Cannot reach Hindsight: {e}")
        sys.exit(1)

    files_to_process = []

    if WINDOWS_DIR.exists():
        win_files = sorted(WINDOWS_DIR.glob("history_*.md"))
        out(f"Windows summaries: {len(win_files)} files")
        files_to_process.extend([(f, "windows") for f in win_files])
    else:
        out(f"Windows dir not found: {WINDOWS_DIR}")

    wsl_dir = get_wsl_path()
    if wsl_dir:
        wsl_files = sorted(wsl_dir.glob("history_*.md"))
        out(f"WSL summaries: {len(wsl_files)} files")
        files_to_process.extend([(f, "wsl") for f in wsl_files])
    else:
        out("WSL summaries dir not accessible from Windows")

    out(f"\nTotal files to process: {len(files_to_process)}")
    out("=" * 60)

    success_count = 0
    fail_count = 0
    skip_count = 0

    for i, (filepath, source) in enumerate(files_to_process, 1):
        session_id = filepath.stem
        out(f"[{i}/{len(files_to_process)}] {session_id} ({source})", end=" ... ")

        ok, result = process_file(filepath, source)
        if ok:
            success_count += 1
            if isinstance(result, dict):
                status = result.get("status", "ok")
                out(f"OK (status={status})")
            else:
                out("OK")
        else:
            if "No meaningful content" in str(result):
                skip_count += 1
                out(f"SKIP: {result}")
            else:
                fail_count += 1
                out(f"FAIL: {result}")

        # Small delay between requests
        time.sleep(0.3)

    out("\n" + "=" * 60)
    out(f"Done! Success: {success_count}, Failed: {fail_count}, Skipped: {skip_count}")
    out(f"Total processed: {success_count + fail_count + skip_count} / {len(files_to_process)}")
    log.close()

if __name__ == "__main__":
    main()
