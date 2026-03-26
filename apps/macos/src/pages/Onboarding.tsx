import { useState, useEffect, useCallback, useRef } from "react";

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
  lastLaunchAt?: string;
}

const DEFAULTS: KoreConfig = {
  clonePath: "~/dev/kore",
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

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "general", label: "General" },
  { id: "llm", label: "LLM" },
  { id: "apple-notes", label: "Apple Notes" },
  { id: "mcp", label: "MCP" },
  { id: "start", label: "Start" },
] as const;

// ── Onboarding component ────────────────────────────────────────────

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<KoreConfig>(DEFAULTS);
  const [koreHome, setKoreHome] = useState<string>("~/.kore");

  // Bridge response state
  const [bunStatus, setBunStatus] = useState<{ path?: string; error?: string } | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<string | null>(null);
  const [notesAccess, setNotesAccess] = useState<string>("unknown");
  const [claudeDesktopDetected, setClaudeDesktopDetected] = useState<boolean | null>(null);
  const [claudeCodeDetected, setClaudeCodeDetected] = useState<boolean | null>(null);
  const [mcpInstallStatus, setMcpInstallStatus] = useState<Record<string, string>>({});
  const [serverStarted, setServerStarted] = useState(false);
  const [configWritten, setConfigWritten] = useState(false);
  const configWrittenRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  const handleBridgeMessage = useCallback(
    (data: unknown) => {
      const msg = data as Record<string, unknown>;
      switch (msg.type) {
        case "resolveKoreHome": {
          const resolved = msg.koreHome as string;
          setKoreHome(resolved);
          // Load existing config so onboarding pre-populates with saved values
          bridgeCall("readConfig", { koreHome: resolved });
          break;
        }
        case "readConfig":
          if (msg.config) {
            const cfg = msg.config as KoreConfig;
            setConfig((prev) => ({ ...prev, ...cfg }));
          }
          break;
        case "checkBunInstalled":
          if (msg.path) {
            setBunStatus({ path: msg.path as string });
          } else {
            setBunStatus({ error: (msg.error as string) ?? "Not found" });
          }
          break;
        case "checkOllamaRunning":
          setOllamaStatus((msg.running as boolean) ? "connected" : "not running");
          break;
        case "checkNotesAccess":
          setNotesAccess(msg.status as string);
          break;
        case "checkClaudeDesktopConfig":
          setClaudeDesktopDetected(msg.detected as boolean);
          break;
        case "checkClaudeCodeConfig":
          setClaudeCodeDetected(msg.detected as boolean);
          break;
        case "installMCPConfig":
          if (msg.success) {
            setMcpInstallStatus((prev) => ({ ...prev, [msg.target as string]: "installed" }));
          } else {
            setMcpInstallStatus((prev) => ({ ...prev, [msg.target as string]: `error: ${msg.error}` }));
          }
          break;
        case "writeConfig":
          if (msg.success) {
            setConfigWritten(true);
            configWrittenRef.current = true;
            // After config is written, start the server
            bridgeCall("startServer", { clonePath: config.clonePath ?? "~/dev/kore", port: config.port ?? 3000 });
          } else {
            setStartError(`Config write failed: ${msg.error}`);
          }
          break;
        case "serverStatus":
          if (msg.status === "running" && configWrittenRef.current) {
            setServerStarted(true);
            // Onboarding complete — close the window automatically
            bridgeCall("closeOnboarding");
          } else if (msg.status === "error") {
            setStartError(`Server error: ${msg.error}`);
          }
          break;
        case "chooseClonePath":
          if (msg.path) {
            setConfig((prev) => ({ ...prev, clonePath: msg.path as string }));
          }
          break;
        case "setLaunchAtLogin":
          if (msg.success) {
            setLaunchAtLogin(msg.enabled as boolean);
          }
          break;
        case "getLaunchAtLogin":
          setLaunchAtLogin(msg.enabled as boolean);
          break;
      }
    },
    [config.clonePath, config.port],
  );

  useEffect(() => {
    window.bridgeCallback = handleBridgeMessage;
    bridgeCall("resolveKoreHome");
    bridgeCall("getLaunchAtLogin");
    return () => {
      window.bridgeCallback = undefined;
    };
  }, [handleBridgeMessage]);


  function updateConfig(patch: Partial<KoreConfig>) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  function updateLlm(patch: Partial<LlmConfig>) {
    setConfig((prev) => ({ ...prev, llm: { ...prev.llm, ...patch } }));
  }

  function updateAppleNotes(patch: Partial<AppleNotesConfig>) {
    setConfig((prev) => ({ ...prev, appleNotes: { ...prev.appleNotes, ...patch } }));
  }

  // Validation: can the user proceed from the current step?
  function canProceed(): boolean {
    if (step === 1) {
      // General: clone path and koreHome are required
      return !!(config.clonePath?.trim());
    }
    return true;
  }

  function handleNext() {
    if (step < STEPS.length - 1 && canProceed()) {
      const nextStep = step + 1;
      setStep(nextStep);
      // Trigger checks when entering certain steps
      if (STEPS[nextStep].id === "general") {
        bridgeCall("checkBunInstalled");
      } else if (STEPS[nextStep].id === "apple-notes") {
        bridgeCall("checkNotesAccess");
      } else if (STEPS[nextStep].id === "mcp") {
        bridgeCall("checkClaudeDesktopConfig");
        bridgeCall("checkClaudeCodeConfig");
      }
    }
  }

  function handleBack() {
    if (step > 0) {
      setStep(step - 1);
    }
  }

  function handleFinish() {
    // Stamp lastLaunchAt so subsequent launches skip onboarding
    bridgeCall("writeConfig", { config: { ...config, lastLaunchAt: new Date().toISOString() }, koreHome });
  }

  const currentStep = STEPS[step];

  return (
    <div className="onboarding">
      {/* Stepper progress */}
      <div className="onboarding-stepper">
        {STEPS.map((s, i) => (
          <div key={s.id} className={`stepper-step ${i === step ? "active" : i < step ? "done" : ""}`}>
            <div className="stepper-dot">{i < step ? "\u2713" : i + 1}</div>
            <span className="stepper-label">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="onboarding-body">
        {currentStep.id === "welcome" && <WelcomeStep />}
        {currentStep.id === "general" && (
          <GeneralStep
            config={config}
            koreHome={koreHome}
            bunStatus={bunStatus}
            updateConfig={updateConfig}
            onCheckBun={() => bridgeCall("checkBunInstalled")}
          />
        )}
        {currentStep.id === "llm" && (
          <LlmStep config={config} ollamaStatus={ollamaStatus} updateLlm={updateLlm} setOllamaStatus={setOllamaStatus} />
        )}
        {currentStep.id === "apple-notes" && (
          <AppleNotesStep config={config} notesAccess={notesAccess} updateAppleNotes={updateAppleNotes} />
        )}
        {currentStep.id === "mcp" && (
          <McpStep
            config={config}
            claudeDesktopDetected={claudeDesktopDetected}
            claudeCodeDetected={claudeCodeDetected}
            mcpInstallStatus={mcpInstallStatus}
          />
        )}
        {currentStep.id === "start" && (
          <StartStep
            configWritten={configWritten}
            serverStarted={serverStarted}
            startError={startError}
            launchAtLogin={launchAtLogin}
            onToggleLaunchAtLogin={(enabled) => bridgeCall("setLaunchAtLogin", { enabled })}
          />
        )}
      </div>

      {/* Navigation */}
      <div className="onboarding-footer">
        <button className="btn-secondary" onClick={handleBack} disabled={step === 0}>
          Back
        </button>
        <div className="onboarding-footer-right">
          {step < STEPS.length - 1 ? (
            <button className="btn-primary onboarding-next" onClick={handleNext} disabled={!canProceed()}>
              {step === 0 ? "Let's configure your setup" : "Next"}
            </button>
          ) : (
            <button
              className="btn-primary onboarding-next"
              onClick={handleFinish}
              disabled={configWritten}
            >
              {configWritten ? "Starting..." : "Start Kore"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step Components ─────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="tab-content onboarding-welcome">
      <h2>Welcome to Kore</h2>
      <p>
        Kore is your context-aware personal memory bank. It passively ingests content from
        your existing tools, uses an LLM to distill it into structured memories, and surfaces
        it automatically through your AI assistant via MCP.
      </p>
      <p>Let's get you set up in a few quick steps.</p>
    </div>
  );
}

function GeneralStep({
  config,
  koreHome,
  bunStatus,
  updateConfig,
  onCheckBun,
}: {
  config: KoreConfig;
  koreHome: string;
  bunStatus: { path?: string; error?: string } | null;
  updateConfig: (patch: Partial<KoreConfig>) => void;
  onCheckBun: () => void;
}) {
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
        <span className="form-value">{koreHome}</span>
        <span className="form-hint">Configuration and data directory</span>
      </div>

      <div className="form-group">
        <label className="form-label">Bun Runtime</label>
        <div className="form-row">
          <button className="btn-secondary btn-small" onClick={onCheckBun}>
            Check Bun
          </button>
          {bunStatus && (
            <span className={`connection-status ${bunStatus.path ? "running" : "error"}`}>
              {bunStatus.path ? `Found: ${bunStatus.path}` : bunStatus.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LlmStep({
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
    setOllamaStatus("checking...");
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
                <span className={`connection-status ${ollamaStatus === "connected" ? "running" : ollamaStatus === "checking..." ? "" : "error"}`}>
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

function AppleNotesStep({
  config,
  notesAccess,
  updateAppleNotes,
}: {
  config: KoreConfig;
  notesAccess: string;
  updateAppleNotes: (patch: Partial<AppleNotesConfig>) => void;
}) {
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

      {config.appleNotes?.enabled && (
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
      )}
    </div>
  );
}

function McpStep({
  config,
  claudeDesktopDetected,
  claudeCodeDetected,
  mcpInstallStatus,
}: {
  config: KoreConfig;
  claudeDesktopDetected: boolean | null;
  claudeCodeDetected: boolean | null;
  mcpInstallStatus: Record<string, string>;
}) {
  const serverURL = `http://localhost:${config.port ?? 3000}`;
  const apiKey = config.apiKey ?? "";

  return (
    <div className="tab-content">
      <h2>MCP Configuration</h2>
      <p className="form-hint" style={{ marginBottom: 16 }}>
        Optionally install MCP server configuration so Claude can connect to Kore.
      </p>

      <div className="mcp-card">
        <div className="mcp-card-header">
          <strong>Claude Desktop</strong>
          <span className={`mcp-status ${claudeDesktopDetected === true ? "detected" : claudeDesktopDetected === false ? "not-detected" : ""}`}>
            {claudeDesktopDetected === null
              ? "Checking..."
              : mcpInstallStatus["claude-desktop"] === "installed"
                ? "Installed"
                : claudeDesktopDetected
                  ? "Config detected"
                  : "Not detected"}
          </span>
        </div>
        <button
          className="btn-secondary"
          onClick={() => bridgeCall("installMCPConfig", { target: "claude-desktop", serverURL, apiKey })}
          disabled={mcpInstallStatus["claude-desktop"] === "installed"}
        >
          {mcpInstallStatus["claude-desktop"] === "installed" ? "Installed" : "Install MCP Config"}
        </button>
        {mcpInstallStatus["claude-desktop"]?.startsWith("error") && (
          <span className="form-hint" style={{ color: "var(--error)" }}>{mcpInstallStatus["claude-desktop"]}</span>
        )}
      </div>

      <div className="mcp-card">
        <div className="mcp-card-header">
          <strong>Claude Code</strong>
          <span className={`mcp-status ${claudeCodeDetected === true ? "detected" : claudeCodeDetected === false ? "not-detected" : ""}`}>
            {claudeCodeDetected === null
              ? "Checking..."
              : mcpInstallStatus["claude-code"] === "installed"
                ? "Installed"
                : claudeCodeDetected
                  ? "Config detected"
                  : "Not detected"}
          </span>
        </div>
        <button
          className="btn-secondary"
          onClick={() => bridgeCall("installMCPConfig", { target: "claude-code", serverURL, apiKey })}
          disabled={mcpInstallStatus["claude-code"] === "installed"}
        >
          {mcpInstallStatus["claude-code"] === "installed" ? "Installed" : "Install MCP Config"}
        </button>
        {mcpInstallStatus["claude-code"]?.startsWith("error") && (
          <span className="form-hint" style={{ color: "var(--error)" }}>{mcpInstallStatus["claude-code"]}</span>
        )}
      </div>
    </div>
  );
}

function StartStep({
  configWritten,
  serverStarted,
  startError,
  launchAtLogin,
  onToggleLaunchAtLogin,
}: {
  configWritten: boolean;
  serverStarted: boolean;
  startError: string | null;
  launchAtLogin: boolean;
  onToggleLaunchAtLogin: (enabled: boolean) => void;
}) {
  return (
    <div className="tab-content">
      <h2>{serverStarted ? "Kore is running" : "Ready to start"}</h2>

      {!configWritten && !startError && (
        <p>Click "Start Kore" to save your configuration and launch the server.</p>
      )}

      {configWritten && !serverStarted && !startError && (
        <div className="form-group">
          <span className="connection-status">Starting server...</span>
        </div>
      )}

      {serverStarted && (
        <div className="form-group">
          <span className="connection-status running">Server is running. You can close this window.</span>
        </div>
      )}

      {startError && (
        <div className="form-group">
          <span className="connection-status error">{startError}</span>
        </div>
      )}

      <div className="form-group" style={{ marginTop: 24 }}>
        <label className="form-label">Launch at Login</label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={launchAtLogin}
            onChange={(e) => onToggleLaunchAtLogin(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
        <span className="form-hint">Start Kore automatically when you log in</span>
      </div>
    </div>
  );
}
