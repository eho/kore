import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Settings } from "./Settings";

// ── Mock bridge ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postMessage = mock((_msg: any) => {}) as any;

function findCall(type: string): Record<string, unknown> | undefined {
  return (postMessage.mock.calls as unknown[][]).find(
    (call: unknown[]) => (call[0] as Record<string, unknown>)?.type === type
  )?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  postMessage.mockClear();

  // Install mock bridge
  (window as any).webkit = {
    messageHandlers: {
      bridge: { postMessage },
    },
  };

  // Simulate readConfig response after render
  (window as any).__simulateBridgeResponse = (data: unknown) => {
    if (window.bridgeCallback) {
      window.bridgeCallback(data);
    }
  };
});

function renderAndLoad(configOverrides: Record<string, unknown> = {}) {
  const result = render(<Settings />);

  // The component calls readConfig and getDaemonStatus on mount.
  // Simulate config response.
  act(() => {
    (window as any).__simulateBridgeResponse({
      type: "readConfig",
      config: {
        port: 3000,
        koreHome: "~/dev/kore",
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
        ...configOverrides,
      },
    });
  });

  act(() => {
    (window as any).__simulateBridgeResponse({
      type: "daemonStatus",
      status: "running",
    });
  });

  return result;
}

// ── Tab rendering tests ─────────────────────────────────────────────

test("renders General tab by default", () => {
  renderAndLoad();
  expect(screen.getByText("General", { selector: "h2" })).toBeTruthy();
  expect(screen.getByText("Clone Path")).toBeTruthy();
  expect(screen.getByText("Port")).toBeTruthy();
  expect(screen.getByText("Daemon Status")).toBeTruthy();
});

test("renders LLM tab when clicked", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("LLM", { selector: "button" }));
  expect(screen.getByText("LLM Provider")).toBeTruthy();
  expect(screen.getByText("Ollama")).toBeTruthy();
  expect(screen.getByText("Gemini")).toBeTruthy();
});

test("renders Apple Notes tab when clicked", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("Apple Notes", { selector: "button" }));
  expect(screen.getByText("Enable Sync")).toBeTruthy();
  expect(screen.getByText("Permission Status")).toBeTruthy();
  expect(screen.getByText("Folder Allowlist")).toBeTruthy();
});

test("renders MCP tab when clicked", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("MCP", { selector: "button" }));
  expect(screen.getByText("MCP Configuration")).toBeTruthy();
  expect(screen.getByText("Claude Desktop")).toBeTruthy();
  expect(screen.getByText("Claude Code")).toBeTruthy();
});

// ── Form state tests ────────────────────────────────────────────────

test("port input updates state", () => {
  renderAndLoad();
  const portInput = screen.getByDisplayValue("3000") as HTMLInputElement;
  fireEvent.change(portInput, { target: { value: "4000" } });
  expect(portInput.value).toBe("4000");
});

test("LLM provider radio switches to Gemini fields", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("LLM", { selector: "button" }));

  const geminiRadio = screen.getByLabelText("Gemini");
  fireEvent.click(geminiRadio);

  expect(screen.getByPlaceholderText("Enter Gemini API key")).toBeTruthy();
  expect(screen.getByPlaceholderText("gemini-2.5-flash-lite")).toBeTruthy();
});

test("changing port shows unsaved changes badge", () => {
  renderAndLoad();
  const portInput = screen.getByDisplayValue("3000") as HTMLInputElement;
  fireEvent.change(portInput, { target: { value: "5000" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
});

test("changing port shows restart required badge", () => {
  renderAndLoad();
  const portInput = screen.getByDisplayValue("3000") as HTMLInputElement;
  fireEvent.change(portInput, { target: { value: "5000" } });
  // Two restart badges — one in footer, one in daemon status row
  const badges = screen.getAllByText("Restart required");
  expect(badges.length).toBeGreaterThanOrEqual(1);
});

// ── Save tests ──────────────────────────────────────────────────────

test("save button calls bridgeCall writeConfig with correct payload", () => {
  renderAndLoad();

  // Make a change so save is enabled
  const portInput = screen.getByDisplayValue("3000") as HTMLInputElement;
  fireEvent.change(portInput, { target: { value: "4000" } });

  // Click save
  const saveButton = screen.getByText("Save");
  fireEvent.click(saveButton);

  // Find the writeConfig call
  const payload = findCall("writeConfig");
  expect(payload).toBeTruthy();
  const writtenConfig = payload!.config as Record<string, unknown>;
  expect(writtenConfig.port).toBe(4000);
});

test("save button is disabled when no changes", () => {
  renderAndLoad();
  const saveButton = screen.getByText("Save") as HTMLButtonElement;
  expect(saveButton.disabled).toBe(true);
});

// ── Daemon control tests ────────────────────────────────────────────

test("daemon start button calls bridgeCall", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("Start"));
  expect(findCall("startDaemon")).toBeTruthy();
});

test("daemon stop button calls bridgeCall", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("Stop"));
  expect(findCall("stopDaemon")).toBeTruthy();
});

// ── Ollama connection test ──────────────────────────────────────────

test("Check Connection calls checkOllamaRunning", () => {
  renderAndLoad();
  fireEvent.click(screen.getByText("LLM", { selector: "button" }));
  fireEvent.click(screen.getByText("Check Connection"));

  const ollamaCall = findCall("checkOllamaRunning");
  expect(ollamaCall).toBeTruthy();
  expect(ollamaCall!.url).toBe("http://localhost:11434");
});
