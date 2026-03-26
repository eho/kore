import { useState, useEffect, useCallback } from "react";

// ── Bridge helpers ──────────────────────────────────────────────────

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        bridge?: { postMessage: (message: unknown) => void };
      };
    };
    bridgeCallback?: (data: unknown) => void;
  }
}

function bridgeCall(type: string, payload: Record<string, unknown> = {}) {
  window.webkit?.messageHandlers?.bridge?.postMessage({ type, ...payload });
}

// ── Types ───────────────────────────────────────────────────────────

interface LlmConfig {
  provider?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

interface AppleNotesConfig {
  enabled?: boolean;
  syncIntervalMs?: number;
  includeHandwriting?: boolean;
  folderAllowlist?: string[];
  folderBlocklist?: string[];
}

interface KoreConfig {
  clonePath?: string;
  koreHome?: string;
  port?: number;
  apiKey?: string;
  llm?: LlmConfig;
  appleNotes?: AppleNotesConfig;
  consolidation?: { intervalMs?: number; cooldownDays?: number; maxAttempts?: number };
  embedIntervalMs?: number;
  mcpEnabled?: boolean;
}

type Tab = "general" | "llm" | "apple-notes" | "mcp";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "llm", label: "LLM" },
  { id: "apple-notes", label: "Apple Notes" },
  { id: "mcp", label: "MCP" },
];

const DEFAULTS: KoreConfig = {
  port: 3000,
  llm: {
    provider: "ollama",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "qwen2.5:7b",
    geminiModel: "gemini-2.5-flash-lite",
  },
  appleNotes: {
    enabled: false,
    syncIntervalMs: 900_000,
    folderAllowlist: [],
    folderBlocklist: [],
  },
  mcpEnabled: true,
};

// ── Settings component ──────────────────────────────────────────────

export function Settings() {
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [config, setConfig] = useState<KoreConfig>(DEFAULTS);
  const [savedConfig, setSavedConfig] = useState<KoreConfig>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Bridge response state
  const [daemonStatus, setDaemonStatus] = useState<{ status: string; error?: string; managed?: boolean }>({ status: "stopped" });
  const [notesAccess, setNotesAccess] = useState<string>("unknown");
  const [ollamaStatus, setOllamaStatus] = useState<string | null>(null);
  const [claudeDesktopDetected, setClaudeDesktopDetected] = useState<boolean | null>(null);
  const [claudeCodeDetected, setClaudeCodeDetected] = useState<boolean | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [koreHome, setKoreHome] = useState<string>("~/.kore");

  // Track which fields changed that require restart
  const [restartRequired, setRestartRequired] = useState(false);

  const handleBridgeMessage = useCallback(
    (data: unknown) => {
      const msg = data as Record<string, unknown>;
      switch (msg.type) {
        case "resolveKoreHome": {
          const resolved = msg.koreHome as string;
          setKoreHome(resolved);
          // Now read config using the resolved home
          bridgeCall("readConfig", { koreHome: resolved });
          break;
        }
        case "readConfig":
          if (msg.config) {
            const cfg = msg.config as KoreConfig;
            setConfig(cfg);
            setSavedConfig(cfg);
          }
          break;
        case "writeConfig":
          setSaving(false);
          if (msg.success) {
            setSavedConfig({ ...config });
            setDirty(false);
            setSaveMessage("Settings saved");
            setTimeout(() => setSaveMessage(null), 2000);
          } else {
            setSaveMessage(`Error: ${msg.error}`);
          }
          break;
        case "daemonStatus":
          setDaemonStatus({
            status: msg.status as string,
            error: msg.error as string | undefined,
            managed: msg.managed as boolean | undefined,
          });
          break;
        case "checkNotesAccess":
          setNotesAccess(msg.status as string);
          break;
        case "checkOllamaRunning":
          setOllamaStatus((msg.running as boolean) ? "connected" : "not running");
          break;
        case "checkClaudeDesktopConfig":
          setClaudeDesktopDetected(msg.detected as boolean);
          break;
        case "checkClaudeCodeConfig":
          setClaudeCodeDetected(msg.detected as boolean);
          break;
        case "chooseClonePath":
          if (msg.path) {
            setConfig((prev) => ({ ...prev, clonePath: msg.path as string }));
          } else if (msg.error) {
            setSaveMessage(`Error: ${msg.error}`);
            setTimeout(() => setSaveMessage(null), 3000);
          }
          break;
      }
    },
    [config],
  );

  useEffect(() => {
    window.bridgeCallback = handleBridgeMessage;
    // Resolve KORE_HOME first, which triggers readConfig with the correct path
    bridgeCall("resolveKoreHome");
    bridgeCall("getDaemonStatus");
    return () => {
      window.bridgeCallback = undefined;
    };
  }, [handleBridgeMessage]);

  // Track dirty state
  useEffect(() => {
    setDirty(JSON.stringify(config) !== JSON.stringify(savedConfig));
  }, [config, savedConfig]);

  // Track restart-required (port or clonePath changed)
  useEffect(() => {
    const portChanged = config.port !== savedConfig.port;
    const cloneChanged = config.clonePath !== savedConfig.clonePath;
    setRestartRequired(portChanged || cloneChanged);
  }, [config.port, config.clonePath, savedConfig.port, savedConfig.clonePath]);

  function updateConfig(patch: Partial<KoreConfig>) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  function updateLlm(patch: Partial<LlmConfig>) {
    setConfig((prev) => ({ ...prev, llm: { ...prev.llm, ...patch } }));
  }

  function updateAppleNotes(patch: Partial<AppleNotesConfig>) {
    setConfig((prev) => ({ ...prev, appleNotes: { ...prev.appleNotes, ...patch } }));
  }

  function handleSave() {
    setSaving(true);
    bridgeCall("writeConfig", { config, koreHome });
  }

  return (
    <div className="settings">
      <div className="settings-sidebar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        <div className="settings-body">
          {activeTab === "general" && (
            <GeneralTab
              config={config}
              koreHome={koreHome}
              daemonStatus={daemonStatus}
              restartRequired={restartRequired}
              updateConfig={updateConfig}
            />
          )}
          {activeTab === "llm" && (
            <LlmTab config={config} ollamaStatus={ollamaStatus} updateLlm={updateLlm} setOllamaStatus={setOllamaStatus} />
          )}
          {activeTab === "apple-notes" && (
            <AppleNotesTab
              config={config}
              notesAccess={notesAccess}
              lastSyncTime={lastSyncTime}
              updateAppleNotes={updateAppleNotes}
              setLastSyncTime={setLastSyncTime}
            />
          )}
          {activeTab === "mcp" && (
            <McpTab
              claudeDesktopDetected={claudeDesktopDetected}
              claudeCodeDetected={claudeCodeDetected}
            />
          )}
        </div>

        <div className="settings-footer">
          {saveMessage && <span className={`save-message ${saveMessage.startsWith("Error") ? "error" : ""}`}>{saveMessage}</span>}
          {dirty && !saveMessage && <span className="unsaved-badge">Unsaved changes</span>}
          {restartRequired && <span className="restart-badge">Restart required</span>}
          <button className="btn-primary settings-save" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── General Tab ─────────────────────────────────────────────────────

function GeneralTab({
  config,
  koreHome,
  daemonStatus,
  restartRequired,
  updateConfig,
}: {
  config: KoreConfig;
  koreHome: string;
  daemonStatus: { status: string; error?: string; managed?: boolean };
  restartRequired: boolean;
  updateConfig: (patch: Partial<KoreConfig>) => void;
}) {
  const statusClass = daemonStatus.status === "running" ? "running" : daemonStatus.status === "error" ? "error" : "stopped";
  const managed = daemonStatus.managed !== false;
  const isRunning = daemonStatus.status === "running";

  return (
    <div className="tab-content">
      <h2>General</h2>

      <div className="form-group">
        <label className="form-label">Clone Path</label>
        <div className="form-row">
          <input
            type="text"
            className="form-input"
            value={config.clonePath ?? ""}
            onChange={(e) => updateConfig({ clonePath: e.target.value })}
            placeholder="~/dev/kore"
          />
          <button className="btn-secondary btn-small" onClick={() => bridgeCall("chooseClonePath")}>
            Choose...
          </button>
        </div>
        <span className="form-hint">Must contain apps/core-api/</span>
      </div>

      <div className="form-group">
        <label className="form-label">KORE_HOME</label>
        <div className="form-row">
          <span className="form-value">{koreHome}</span>
          <button className="btn-secondary btn-small" onClick={() => bridgeCall("revealInFinder", { path: koreHome })}>
            Reveal in Finder
          </button>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Port</label>
        <input
          type="number"
          className="form-input form-input-narrow"
          value={config.port ?? 3000}
          onChange={(e) => updateConfig({ port: parseInt(e.target.value) || 3000 })}
          min={1}
          max={65535}
        />
      </div>

      <div className="form-group">
        <label className="form-label">Launch at Login</label>
        <label className="toggle">
          <input
            type="checkbox"
            onChange={(e) => bridgeCall("setLaunchAtLogin", { enabled: e.target.checked })}
          />
          <span className="toggle-slider" />
        </label>
        <span className="form-hint">Implemented in MAC-006</span>
      </div>

      <div className="form-group">
        <label className="form-label">Daemon Status</label>
        <div className="daemon-status-row">
          <span className={`status-indicator ${statusClass}`}>
            <span className={`status-dot ${statusClass}`} />
            {daemonStatus.status.charAt(0).toUpperCase() + daemonStatus.status.slice(1)}
            {daemonStatus.error ? `: ${daemonStatus.error}` : ""}
          </span>
          {restartRequired && <span className="restart-badge">Restart required</span>}
        </div>
        {isRunning && !managed && (
          <span className="form-hint">Externally started — use your terminal to stop this server</span>
        )}
        <div className="daemon-controls">
          <button className="btn-secondary btn-small" disabled={isRunning} onClick={() => bridgeCall("startDaemon", { clonePath: config.clonePath ?? "~/dev/kore", port: config.port })}>
            Start
          </button>
          <button className="btn-secondary btn-small" disabled={!managed || !isRunning} onClick={() => bridgeCall("stopDaemon")}>
            Stop
          </button>
          <button className="btn-secondary btn-small" disabled={!managed || !isRunning} onClick={() => bridgeCall("restartDaemon")}>
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LLM Tab ─────────────────────────────────────────────────────────

function LlmTab({
  config,
  ollamaStatus,
  updateLlm,
  setOllamaStatus,
}: {
  config: KoreConfig;
  ollamaStatus: string | null;
  updateLlm: (patch: Partial<LlmConfig>) => void;
  setOllamaStatus: (s: string | null) => void;
}) {
  const provider = config.llm?.provider ?? "ollama";

  function checkOllama() {
    setOllamaStatus("checking…");
    bridgeCall("checkOllamaRunning", { url: config.llm?.ollamaBaseUrl ?? "http://localhost:11434" });
  }

  return (
    <div className="tab-content">
      <h2>LLM Provider</h2>

      <div className="form-group">
        <label className="form-label">Provider</label>
        <div className="radio-group">
          <label className="radio-label">
            <input type="radio" name="provider" value="ollama" checked={provider === "ollama"} onChange={() => updateLlm({ provider: "ollama" })} />
            Ollama
          </label>
          <label className="radio-label">
            <input type="radio" name="provider" value="gemini" checked={provider === "gemini"} onChange={() => updateLlm({ provider: "gemini" })} />
            Gemini
          </label>
        </div>
      </div>

      {provider === "ollama" && (
        <>
          <div className="form-group">
            <label className="form-label">Model</label>
            <input
              type="text"
              className="form-input"
              value={config.llm?.ollamaModel ?? ""}
              onChange={(e) => updateLlm({ ollamaModel: e.target.value })}
              placeholder="qwen2.5:7b"
            />
          </div>
          <div className="form-group">
            <label className="form-label">URL</label>
            <input
              type="text"
              className="form-input"
              value={config.llm?.ollamaBaseUrl ?? ""}
              onChange={(e) => updateLlm({ ollamaBaseUrl: e.target.value })}
              placeholder="http://localhost:11434"
            />
          </div>
          <div className="form-group">
            <div className="form-row">
              <button className="btn-secondary" onClick={checkOllama}>
                Check Connection
              </button>
              {ollamaStatus && (
                <span className={`connection-status ${ollamaStatus === "connected" ? "running" : ollamaStatus === "checking…" ? "" : "error"}`}>
                  {ollamaStatus}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {provider === "gemini" && (
        <>
          <div className="form-group">
            <label className="form-label">API Key</label>
            <input
              type="password"
              className="form-input"
              value={config.llm?.geminiApiKey ?? ""}
              onChange={(e) => updateLlm({ geminiApiKey: e.target.value })}
              placeholder="Enter Gemini API key"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Model</label>
            <input
              type="text"
              className="form-input"
              value={config.llm?.geminiModel ?? ""}
              onChange={(e) => updateLlm({ geminiModel: e.target.value })}
              placeholder="gemini-2.5-flash-lite"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Apple Notes Tab ─────────────────────────────────────────────────

function AppleNotesTab({
  config,
  notesAccess,
  lastSyncTime,
  updateAppleNotes,
  setLastSyncTime,
}: {
  config: KoreConfig;
  notesAccess: string;
  lastSyncTime: string | null;
  updateAppleNotes: (patch: Partial<AppleNotesConfig>) => void;
  setLastSyncTime: (s: string | null) => void;
}) {
  const syncIntervalMin = Math.round((config.appleNotes?.syncIntervalMs ?? 900_000) / 60_000);

  useEffect(() => {
    bridgeCall("checkNotesAccess");
  }, []);

  function handleSyncNow() {
    setLastSyncTime("syncing…");
    // Call daemon API to sync — this goes through the bridge
    bridgeCall("syncAppleNotes");
  }

  const accessClass = notesAccess === "granted" ? "running" : notesAccess === "denied" ? "error" : "";

  return (
    <div className="tab-content">
      <h2>Apple Notes</h2>

      <div className="form-group">
        <label className="form-label">Enable Sync</label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.appleNotes?.enabled ?? false}
            onChange={(e) => updateAppleNotes({ enabled: e.target.checked })}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div className="form-group">
        <label className="form-label">Permission Status</label>
        <div className="form-row">
          <span className={`connection-status ${accessClass}`}>
            {notesAccess.charAt(0).toUpperCase() + notesAccess.slice(1)}
          </span>
          {notesAccess !== "granted" && (
            <button className="btn-secondary btn-small" onClick={() => bridgeCall("openFDASettings")}>
              Grant Access
            </button>
          )}
          <button className="btn-secondary btn-small" onClick={() => bridgeCall("checkNotesAccess")}>
            Refresh
          </button>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Folder Allowlist</label>
        <input
          type="text"
          className="form-input"
          value={(config.appleNotes?.folderAllowlist ?? []).join(", ")}
          onChange={(e) =>
            updateAppleNotes({
              folderAllowlist: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="Comma-separated folder names"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Folder Blocklist</label>
        <input
          type="text"
          className="form-input"
          value={(config.appleNotes?.folderBlocklist ?? []).join(", ")}
          onChange={(e) =>
            updateAppleNotes({
              folderBlocklist: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="Comma-separated folder names"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Sync Interval: {syncIntervalMin} min</label>
        <input
          type="range"
          className="form-slider"
          min={5}
          max={60}
          value={syncIntervalMin}
          onChange={(e) => updateAppleNotes({ syncIntervalMs: parseInt(e.target.value) * 60_000 })}
        />
        <div className="slider-labels">
          <span>5 min</span>
          <span>60 min</span>
        </div>
      </div>

      <div className="form-group">
        <div className="form-row">
          <button className="btn-secondary" onClick={handleSyncNow}>
            Sync Now
          </button>
          <span className="form-hint">{lastSyncTime ? `Last sync: ${lastSyncTime}` : "Last sync: Never"}</span>
        </div>
      </div>
    </div>
  );
}

// ── MCP Tab ─────────────────────────────────────────────────────────

function McpTab({
  claudeDesktopDetected,
  claudeCodeDetected,
}: {
  claudeDesktopDetected: boolean | null;
  claudeCodeDetected: boolean | null;
}) {
  useEffect(() => {
    // Check for Claude Desktop config file
    bridgeCall("checkClaudeDesktopConfig");
    bridgeCall("checkClaudeCodeConfig");
  }, []);

  return (
    <div className="tab-content">
      <h2>MCP Configuration</h2>
      <p className="form-hint" style={{ marginBottom: 16 }}>
        Install MCP server configuration so Claude can connect to Kore.
      </p>

      <div className="mcp-card">
        <div className="mcp-card-header">
          <strong>Claude Desktop</strong>
          <span className={`mcp-status ${claudeDesktopDetected === true ? "detected" : claudeDesktopDetected === false ? "not-detected" : ""}`}>
            {claudeDesktopDetected === null ? "Checking…" : claudeDesktopDetected ? "Config detected" : "Not detected"}
          </span>
        </div>
        <button
          className="btn-secondary"
          onClick={() => bridgeCall("installMCPConfig", { target: "claude-desktop" })}
          title="Implementation in MAC-006"
        >
          Install MCP Config
        </button>
      </div>

      <div className="mcp-card">
        <div className="mcp-card-header">
          <strong>Claude Code</strong>
          <span className={`mcp-status ${claudeCodeDetected === true ? "detected" : claudeCodeDetected === false ? "not-detected" : ""}`}>
            {claudeCodeDetected === null ? "Checking…" : claudeCodeDetected ? "Config detected" : "Not detected"}
          </span>
        </div>
        <button
          className="btn-secondary"
          onClick={() => bridgeCall("installMCPConfig", { target: "claude-code" })}
          title="Implementation in MAC-006"
        >
          Install MCP Config
        </button>
      </div>
    </div>
  );
}
