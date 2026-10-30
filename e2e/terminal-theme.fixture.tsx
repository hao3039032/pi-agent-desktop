import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
import { LazyTerminalPanel, preloadTerminalPanel } from "../components/LazyTerminalPanel";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [preloaded, setPreloaded] = useState(false);
  return <main style={{ height: "100%", display: "grid", gridTemplateRows: "80px minmax(0, 1fr)" }}>
    <nav>
      <button onClick={() => { void preloadTerminalPanel().then(() => setPreloaded(true)); }}>
        {preloaded ? "Renderer preloaded" : "Preload renderer"}
      </button>
      <button onClick={() => setOpen(true)}>Open terminal</button>
    </nav>
    <div data-terminal-slot style={{ minHeight: 0 }}>
      {open && <LazyTerminalPanel tab={{ id: "a".repeat(32), cwd: "C:\\Projects\\示例",
        restored: new URLSearchParams(location.search).has("restored") }} active
        onRestart={() => {}} onClosed={() => {}} onCloseError={() => {}} />}
    </div>
  </main>;
}

// Pi Agent LW ships zh-CN as the first-launch locale; these upstream fixtures
// assert English labels, so pin the stored preference the way a user would.
// Only when the test has not chosen a locale itself (addInitScript wins).
if (typeof localStorage !== "undefined" && !localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en");
createRoot(document.getElementById("root")!).render(<I18nProvider><Fixture /></I18nProvider>);
