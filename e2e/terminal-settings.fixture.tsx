import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
import { SettingsPanel } from "../components/SettingsPanel";
import { THEME_INIT_SCRIPT } from "../lib/theme";

window.eval(THEME_INIT_SCRIPT);
// Pi Agent LW ships zh-CN as the first-launch locale; these upstream fixtures
// assert English labels, so pin the stored preference the way a user would.
// Only when the test has not chosen a locale itself (addInitScript wins).
if (typeof localStorage !== "undefined" && !localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en");
createRoot(document.getElementById("root")!).render(<I18nProvider>
  <div className="app-shell" style={{ height: "100dvh" }}>
    <SettingsPanel cwd={null} sessionId={null} initialSection="general" onClose={() => {}}
      onSessionReloaded={() => {}} quoteSelectionEnabled onQuoteSelectionChange={() => {}}
      soundEnabled={false} onSoundToggle={() => {}} />
  </div>
</I18nProvider>);
