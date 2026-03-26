import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { Onboarding } from "./Onboarding";

// ── Mock bridge ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postMessage = mock((_msg: any) => {}) as any;

function findCall(type: string): Record<string, unknown> | undefined {
  return (postMessage.mock.calls as unknown[][]).find(
    (call: unknown[]) => (call[0] as Record<string, unknown>)?.type === type
  )?.[0] as Record<string, unknown> | undefined;
}

function simulate(data: unknown) {
  act(() => {
    if (window.bridgeCallback) {
      window.bridgeCallback(data);
    }
  });
}

beforeEach(() => {
  postMessage.mockClear();

  (window as any).webkit = {
    messageHandlers: {
      bridge: { postMessage },
    },
  };
});

afterEach(() => {
  cleanup();
});

function renderOnboarding() {
  const result = render(<Onboarding />);
  simulate({ type: "resolveKoreHome", koreHome: "~/.kore" });
  simulate({ type: "getLaunchAtLogin", enabled: false });
  return result;
}

// ── Stepper tests ───────────────────────────────────────────────────

test("renders welcome step on mount", () => {
  renderOnboarding();
  expect(screen.getByText("Welcome to Kore")).toBeTruthy();
  expect(screen.getByText("Let's configure your setup")).toBeTruthy();
});

test("stepper advances to General on next click", () => {
  renderOnboarding();
  fireEvent.click(screen.getByText("Let's configure your setup"));
  expect(screen.getByText("General", { selector: "h2" })).toBeTruthy();
  expect(screen.getByText("Clone Path")).toBeTruthy();
});

test("stepper goes back from General to Welcome", () => {
  renderOnboarding();
  fireEvent.click(screen.getByText("Let's configure your setup"));
  expect(screen.getByText("General", { selector: "h2" })).toBeTruthy();

  fireEvent.click(screen.getByText("Back"));
  expect(screen.getByText("Welcome to Kore")).toBeTruthy();
});

test("back button is disabled on welcome step", () => {
  renderOnboarding();
  const backButton = screen.getByText("Back") as HTMLButtonElement;
  expect(backButton.disabled).toBe(true);
});

test("stepper advances through all steps", () => {
  renderOnboarding();

  // Welcome → General
  fireEvent.click(screen.getByText("Let's configure your setup"));
  expect(screen.getByText("General", { selector: "h2" })).toBeTruthy();

  // General → LLM (clone path auto-filled with ~/dev/kore)
  fireEvent.click(screen.getByText("Next"));
  expect(screen.getByText("LLM Provider")).toBeTruthy();

  // LLM → Apple Notes
  fireEvent.click(screen.getByText("Next"));
  expect(screen.getByText("Apple Notes", { selector: "h2" })).toBeTruthy();

  // Apple Notes → MCP
  fireEvent.click(screen.getByText("Next"));
  expect(screen.getByText("MCP Configuration")).toBeTruthy();

  // MCP → Start
  fireEvent.click(screen.getByText("Next"));
  expect(screen.getByText("Ready to start")).toBeTruthy();
});

// ── Required fields block progression ───────────────────────────────

test("General step blocks next when clone path is empty", () => {
  renderOnboarding();
  fireEvent.click(screen.getByText("Let's configure your setup"));

  // Clear clone path
  const cloneInput = screen.getByPlaceholderText("~/dev/kore") as HTMLInputElement;
  fireEvent.change(cloneInput, { target: { value: "" } });

  const nextButton = screen.getByText("Next") as HTMLButtonElement;
  expect(nextButton.disabled).toBe(true);
});

// ── Start step tests ────────────────────────────────────────────────

test("Start step calls writeConfig then startDaemon", () => {
  renderOnboarding();

  // Navigate to Start step
  fireEvent.click(screen.getByText("Let's configure your setup"));
  fireEvent.click(screen.getByText("Next")); // → LLM
  fireEvent.click(screen.getByText("Next")); // → Apple Notes
  fireEvent.click(screen.getByText("Next")); // → MCP
  fireEvent.click(screen.getByText("Next")); // → Start

  // Click Start Kore
  fireEvent.click(screen.getByText("Start Kore"));
  expect(findCall("writeConfig")).toBeTruthy();

  // Simulate config written successfully → should auto-call startDaemon
  simulate({ type: "writeConfig", success: true });
  expect(findCall("startDaemon")).toBeTruthy();
});

test("Start step auto-closes when daemon starts", () => {
  renderOnboarding();

  // Navigate to Start
  fireEvent.click(screen.getByText("Let's configure your setup"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));

  fireEvent.click(screen.getByText("Start Kore"));
  simulate({ type: "writeConfig", success: true });
  simulate({ type: "daemonStatus", status: "running" });

  expect(findCall("closeOnboarding")).toBeTruthy();
});

// ── MCP install ─────────────────────────────────────────────────────

test("MCP step install buttons call installMCPConfig", () => {
  renderOnboarding();

  // Navigate to MCP step
  fireEvent.click(screen.getByText("Let's configure your setup"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));

  const buttons = screen.getAllByText("Install MCP Config");
  fireEvent.click(buttons[0]); // Claude Desktop

  const call = findCall("installMCPConfig");
  expect(call).toBeTruthy();
  expect(call!.target).toBe("claude-desktop");
});
