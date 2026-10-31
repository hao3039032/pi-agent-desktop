// Test-only composition of the actual terminal panel and settings section.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPanel } from "../../components/TerminalPanel";
import { TerminalSettingsSection } from "../../components/TerminalSettingsSection";
import { I18nProvider } from "../../hooks/useI18n";
import { bindTerminalClient } from "../../static-frontend/src/data/terminal-client";
import { detectTransport } from "../../static-frontend/src/data/transport";
import { IpcClient } from "../../static-frontend/src/ipc/client";
import "../../app/globals.css";
import "../../app/settings.css";
import "../../app/native-theme.css";

const client = new IpcClient(detectTransport().transport);
bindTerminalClient(client);
const cwd = new URLSearchParams(location.search).get("cwd") ?? "";

function Fixture() {
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [restored] = useState(() => sessionStorage.getItem("terminal-fixture-started") === "yes");
  useEffect(() => {
    void client.request("cwd.validate", { cwd }).then(() => { setReady(true); sessionStorage.setItem("terminal-fixture-started", "yes"); });
  }, []);
  if (!ready) return <p>Authorizing project</p>;
  return <I18nProvider>
    <button onClick={() => setActive(0)}>Terminal tab</button>
    <button onClick={() => setActive(1)}>Other tab</button>
    <button onClick={() => setClosing(true)}>Close fixture terminal</button>
    <TerminalSettingsSection />
    {!closed && <div style={{ display: active === 0 ? "block" : "none", height: 400, width: 800 }}>
      <TerminalPanel tab={{ id: "fixture-terminal", cwd, restored, closing: closing ? "close" : undefined }} active={active === 0} onRestart={() => {}} onClosed={() => setClosed(true)} onCloseError={() => {}} />
    </div>}
    {closed && <p>Fixture terminal closed</p>}
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
