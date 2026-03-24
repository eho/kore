import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

function App() {
  const [status, setStatus] = useState<string>("idle");

  async function checkDaemon() {
    try {
      const result = await invoke<string>("get_daemon_status");
      setStatus(result);
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="panel">
      <div className="header">
        <div className="logo">K</div>
        <div className="title">
          <h1>Kore</h1>
          <p>Context-Aware Memory</p>
        </div>
      </div>

      <div className="status-row">
        <span className="status-label">Daemon</span>
        <span className={`status-badge status-${status}`}>{status}</span>
      </div>

      <div className="actions">
        <button onClick={checkDaemon} className="btn-primary">
          Check Status
        </button>
      </div>

      <div className="footer">
        <span>Kore v0.1.0</span>
      </div>
    </div>
  );
}

export default App;
