// Test-only: original UI with the real Rust IPC/resource bridge.
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../hooks/useI18n";
import { FileViewer } from "../../components/FileViewer";
import { FileExplorer } from "../../components/FileExplorer";
import { MarkdownBody } from "../../components/MarkdownBody";
import { bindFileService } from "../../static-frontend/src/data/file-service";
import { detectTransport } from "../../static-frontend/src/data/transport";
import { IpcClient } from "../../static-frontend/src/ipc/client";
import "../../app/globals.css";
import "../../app/settings.css";
import "../../app/native-theme.css";

bindFileService(new IpcClient(detectTransport().transport));
const cwd = new URLSearchParams(location.search).get("cwd") ?? "";
createRoot(document.getElementById("root")!).render(<I18nProvider>
  <MarkdownBody cwd={cwd} onOpenFile={(path) => { document.body.dataset.openedFile = path; }}>{"![fixture](image.png) [local](style.css)"}</MarkdownBody>
  <div style={{ height: 600 }}><FileViewer filePath={`${cwd}/index.html`} cwd={cwd} initialDisplayMode="preview" /></div>
  <div style={{ height: 300 }}><FileViewer filePath={`${cwd}/document.docx`} cwd={cwd} watchEnabled={false} /></div>
  <div style={{ height: 200 }}><FileViewer filePath={`${cwd}/large.wav`} cwd={cwd} watchEnabled={false} /></div>
  <div style={{ height: 300 }}><FileExplorer cwd={cwd} onOpenFile={() => {}} changesCollapsed={true} /></div>
</I18nProvider>);
