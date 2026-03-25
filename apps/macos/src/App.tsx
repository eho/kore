import { useState, useEffect } from "react";

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        bridge?: {
          postMessage: (message: unknown) => void;
        };
      };
    };
    bridgeCallback?: (data: unknown) => void;
  }
}

export function App() {
  const [bridgeResponse, setBridgeResponse] = useState<string | null>(null);
  const [pingCount, setPingCount] = useState(0);

  useEffect(() => {
    // Register the callback for Swift → JS messages
    window.bridgeCallback = (data: unknown) => {
      setBridgeResponse(JSON.stringify(data, null, 2));
    };

    return () => {
      window.bridgeCallback = undefined;
    };
  }, []);

  const sendPing = () => {
    setPingCount((c) => c + 1);
    window.webkit?.messageHandlers?.bridge?.postMessage({ type: "ping" });
  };

  const isInWebView = Boolean(window.webkit?.messageHandlers?.bridge);

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="status-dot running" />
        <span className="panel-title">Kore</span>
      </header>

      <div className="panel-body">
        <div className="status-section">
          <div className="status-row">
            <span className="label">Daemon</span>
            <span className="value running">Running</span>
          </div>
          <div className="status-row">
            <span className="label">Bridge</span>
            <span className={`value ${isInWebView ? "running" : "stopped"}`}>
              {isInWebView ? "Connected" : "Not in WebView"}
            </span>
          </div>
        </div>

        <div className="bridge-section">
          <button className="btn-primary" onClick={sendPing}>
            Test Bridge (ping){pingCount > 0 ? ` ×${pingCount}` : ""}
          </button>

          {bridgeResponse && (
            <pre className="bridge-response">{bridgeResponse}</pre>
          )}
        </div>
      </div>

      <footer className="panel-footer">
        <button className="btn-text">Settings...</button>
        <button className="btn-text btn-quit">Quit Kore</button>
      </footer>
    </div>
  );
}
