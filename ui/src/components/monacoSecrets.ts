/**
 * Monaco Editor integration for ${secret.*} placeholders.
 *
 * Provides a color-picker-like UX:
 *   1. Colored underlines — green (set) / red wavy (missing)
 *   2. Hover tooltip — shows secret name + status
 *   3. Click-to-edit — inline popup with password input, Save, Cancel
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

// ── Types ──────────────────────────────────────────────────────────

export interface SecretStatus {
  name: string;
  exists: boolean;
}

/** Callback invoked when the user saves a secret value via the popup. */
type SaveSecretFn = (name: string, value: string) => Promise<boolean>;

/** Returned handle for the parent component. */
export interface MonacoSecretsHandle {
  /** Push new secret status and re-render decorations. */
  updateSecrets(secrets: SecretStatus[]): void;
  /** Tear down listeners, decorations, widgets. */
  dispose(): void;
}

// ── CSS injection ──────────────────────────────────────────────────

const STYLE_ID = "monaco-secret-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .secret-placeholder-set {
      text-decoration: underline 2px #4caf50;
      text-underline-offset: 3px;
      cursor: pointer !important;
    }
    .secret-placeholder-missing {
      text-decoration: underline wavy 1.5px #f44336;
      text-underline-offset: 3px;
      cursor: pointer !important;
    }
  `;
  document.head.appendChild(style);
}

// ── Helpers ─────────────────────────────────────────────────────────

const SECRET_RE = /\$\{secret\.([^}]+)\}/g;

interface SecretMatch {
  name: string;
  range: monaco.Range;
}

function findSecretsInModel(model: monaco.editor.ITextModel): SecretMatch[] {
  const text = model.getValue();
  const out: SecretMatch[] = [];
  let m: RegExpExecArray | null;
  SECRET_RE.lastIndex = 0;
  while ((m = SECRET_RE.exec(text)) !== null) {
    const start = model.getPositionAt(m.index);
    const end = model.getPositionAt(m.index + m[0].length);
    out.push({
      name: m[1],
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
    });
  }
  return out;
}

function secretAtPosition(
  model: monaco.editor.ITextModel,
  pos: monaco.Position,
): SecretMatch | null {
  for (const s of findSecretsInModel(model)) {
    if (s.range.containsPosition(pos)) return s;
  }
  return null;
}

// ── Content widget (inline popup) ──────────────────────────────────

class SecretInputWidget implements monaco.editor.IContentWidget {
  private domNode: HTMLDivElement;

  constructor(
    private secret: SecretMatch,
    private exists: boolean,
    private isDark: boolean,
    private onSave: (value: string) => void,
    private onClose: () => void,
  ) {
    this.domNode = this.buildDOM();
  }

  getId() {
    return "secret-input-widget";
  }
  getDomNode() {
    return this.domNode;
  }
  getPosition(): monaco.editor.IContentWidgetPosition {
    return {
      position: {
        lineNumber: this.secret.range.startLineNumber,
        column: this.secret.range.startColumn,
      },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    };
  }

  focus() {
    const input = this.domNode.querySelector("input");
    if (input) setTimeout(() => input.focus(), 30);
  }

  private buildDOM(): HTMLDivElement {
    const bg = this.isDark ? "#252526" : "#ffffff";
    const fg = this.isDark ? "#cccccc" : "#333333";
    const border = this.isDark ? "#555555" : "#c8c8c8";
    const inputBg = this.isDark ? "#3c3c3c" : "#f5f5f5";
    const accent = "#0e639c";

    const wrap = document.createElement("div");
    wrap.style.cssText = `
      padding: 12px 14px; border-radius: 6px;
      border: 1px solid ${border}; background: ${bg}; color: ${fg};
      box-shadow: 0 4px 16px rgba(0,0,0,${this.isDark ? 0.5 : 0.15});
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px; min-width: 280px; z-index: 100;
    `;

    // Header
    const hdr = document.createElement("div");
    hdr.style.cssText = "display:flex; align-items:center; gap:6px; margin-bottom:8px;";
    const icon = document.createElement("span");
    icon.textContent = "\uD83D\uDD11"; // 🔑
    icon.style.fontSize = "14px";
    const title = document.createElement("span");
    title.style.fontWeight = "600";
    title.textContent = this.secret.name;
    const badge = document.createElement("span");
    badge.style.cssText = `
      font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: auto;
      background: ${this.exists ? "#4caf5022" : "#f4433622"};
      color: ${this.exists ? "#4caf50" : "#f44336"};
      border: 1px solid ${this.exists ? "#4caf5044" : "#f4433644"};
    `;
    badge.textContent = this.exists ? "set" : "missing";
    hdr.append(icon, title, badge);
    wrap.appendChild(hdr);

    // Input with inline visibility toggle
    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = `position: relative; display: flex; align-items: center;`;

    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = this.exists ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (enter new value)" : "Enter secret value\u2026";
    input.style.cssText = `
      width: 100%; padding: 6px 30px 6px 8px; box-sizing: border-box;
      background: ${inputBg}; color: ${fg};
      border: 1px solid ${border}; border-radius: 4px;
      outline: none; font-size: 12px; font-family: monospace;
    `;
    input.onfocus = () => { input.style.borderColor = accent; };
    input.onblur = () => { input.style.borderColor = border; };
    inputWrap.appendChild(input);

    // SVG paths for eye / eye-off (Lucide icons)
    const eyeShowPath = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
    const eyeHidePath = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.title = "Show value";
    toggle.style.cssText = `
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; padding: 3px;
      display: flex; align-items: center; justify-content: center;
      color: ${this.isDark ? "#888" : "#999"}; border-radius: 3px;
    `;
    toggle.onmouseenter = () => { toggle.style.color = fg; };
    toggle.onmouseleave = () => { toggle.style.color = this.isDark ? "#888" : "#999"; };
    const makeSvg = (paths: string) =>
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    toggle.innerHTML = makeSvg(eyeShowPath);

    toggle.onclick = () => {
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      toggle.innerHTML = makeSvg(visible ? eyeHidePath : eyeShowPath);
      toggle.title = visible ? "Hide value" : "Show value";
      input.focus();
    };
    inputWrap.appendChild(toggle);
    wrap.appendChild(inputWrap);

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "margin-top:10px; display:flex; gap:8px; justify-content:flex-end;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      padding: 4px 12px; font-size: 11px; cursor: pointer;
      background: transparent; color: ${fg};
      border: 1px solid ${border}; border-radius: 3px;
    `;
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = this.isDark ? "#3c3c3c" : "#e8e8e8"; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = "transparent"; };
    cancelBtn.onclick = () => this.onClose();

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.cssText = `
      padding: 4px 14px; font-size: 11px; cursor: pointer;
      background: ${accent}; color: #ffffff;
      border: none; border-radius: 3px; font-weight: 500;
    `;
    saveBtn.onmouseenter = () => { saveBtn.style.background = "#1177bb"; };
    saveBtn.onmouseleave = () => { saveBtn.style.background = accent; };
    saveBtn.onclick = () => {
      const v = input.value.trim();
      if (v) {
        saveBtn.textContent = "Saving\u2026";
        saveBtn.style.opacity = "0.7";
        this.onSave(v);
      }
    };

    btnRow.append(cancelBtn, saveBtn);
    wrap.appendChild(btnRow);

    // Keyboard shortcuts
    input.onkeydown = (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.onClose();
      }
      e.stopPropagation(); // prevent Monaco from handling
    };

    // Stop all keyboard events from reaching Monaco
    wrap.onkeydown = (e) => e.stopPropagation();
    wrap.onkeyup = (e) => e.stopPropagation();
    wrap.onkeypress = (e) => e.stopPropagation();

    return wrap;
  }
}

// ── Main setup ─────────────────────────────────────────────────────

export function setupMonacoSecrets(
  editor: monaco.editor.IStandaloneCodeEditor,
  initialSecrets: SecretStatus[],
  onSave: SaveSecretFn,
): MonacoSecretsHandle {
  injectStyles();

  let secrets = initialSecrets;
  let decorationIds: string[] = [];
  let activeWidget: SecretInputWidget | null = null;
  const disposables: monaco.IDisposable[] = [];

  // ── Decorations ──

  function refreshDecorations() {
    const model = editor.getModel();
    if (!model) return;
    const matches = findSecretsInModel(model);
    const newDecs: monaco.editor.IModelDeltaDecoration[] = matches.map((m) => {
      const info = secrets.find((s) => s.name === m.name);
      const exists = info?.exists ?? false;
      return {
        range: m.range,
        options: {
          inlineClassName: exists ? "secret-placeholder-set" : "secret-placeholder-missing",
          hoverMessage: {
            value: `**\uD83D\uDD11 ${m.name}** \u2014 ${exists ? "\u2705 Set" : "\u274C Missing"}\n\n*Click to ${exists ? "update" : "set value"}*`,
          },
        },
      };
    });
    decorationIds = editor.deltaDecorations(decorationIds, newDecs);
  }

  // Refresh on content change (user adds/removes placeholders)
  const model = editor.getModel();
  if (model) {
    disposables.push(model.onDidChangeContent(() => refreshDecorations()));
  }
  refreshDecorations();

  // ── Click handler ──

  function removeWidget() {
    if (activeWidget) {
      editor.removeContentWidget(activeWidget);
      activeWidget = null;
      editor.focus();
    }
  }

  disposables.push(
    editor.onMouseDown((e) => {
      // If clicking inside the widget, don't close it
      if (activeWidget) {
        const widgetDom = activeWidget.getDomNode();
        if (e.event.browserEvent.target instanceof Node && widgetDom.contains(e.event.browserEvent.target as Node)) {
          return;
        }
        removeWidget();
      }

      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      const pos = e.target.position;
      if (!pos) return;

      const m = editor.getModel();
      if (!m) return;
      const hit = secretAtPosition(m, pos);
      if (!hit) return;

      const info = secrets.find((s) => s.name === hit.name);
      const exists = info?.exists ?? false;
      const themeName = (editor as any)._themeService?.getColorTheme?.()?.type;
      const isDark = themeName ? themeName === "dark" : true;

      const widget = new SecretInputWidget(
        hit,
        exists,
        isDark,
        async (value) => {
          const ok = await onSave(hit.name, value);
          if (ok) removeWidget();
        },
        () => removeWidget(),
      );
      activeWidget = widget;
      editor.addContentWidget(widget);
      widget.focus();
    }),
  );

  // Close widget on Escape (editor-level)
  disposables.push(
    editor.onKeyDown((e) => {
      if (activeWidget && e.keyCode === monaco.KeyCode.Escape) {
        removeWidget();
        e.preventDefault();
        e.stopPropagation();
      }
    }),
  );

  // ── Public handle ──

  return {
    updateSecrets(newSecrets: SecretStatus[]) {
      secrets = newSecrets;
      refreshDecorations();
    },
    dispose() {
      removeWidget();
      decorationIds = editor.deltaDecorations(decorationIds, []);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
