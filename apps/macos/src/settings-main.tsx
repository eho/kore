import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Settings } from "./pages/Settings";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <Settings />
  </StrictMode>
);
