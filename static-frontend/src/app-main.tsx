/**
 * The static app entry (M2 UI migration): the exact tree app/page.tsx
 * rendered, with the head pieces app/layout.tsx carried (theme/font init
 * scripts, the katex + globals + settings + native-theme cascade).
 */
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

// The CSS cascade in the layout's order: katex, upstream globals/settings
// (byte-identical), then the fork layer last.
import "katex/dist/katex.min.css";
import "../../app/globals.css";
import "../../app/settings.css";
import "../../app/native-theme.css";

import { AppShell } from "../../components/AppShell";
import { I18nProvider } from "../../hooks/useI18n";
import { DistroSetupGate } from "../../components/distro";
import { bindAgentClient } from "./data/agent-client.ts";
import { bindDesktopConnection } from "./data/desktop-connection.ts";
import { bindFileService } from "./data/file-service.ts";
import { bindModelsService } from "./data/models-service.ts";
import { bindProjectTrustClient } from "./data/project-trust-client.ts";
import { bindScheduledTasksStore } from "./data/scheduled-tasks-store.ts";
import { bindSessionListService } from "./data/session-list-service.ts";
import { bindSessionViewService } from "./data/session-view-service.ts";
import { bindStateMirrorClient, importStateMirrorBeforeMount } from "./data/state-mirror.ts";
import { bindWorkspaceService } from "./data/workspace-service.ts";
import { detectTransport } from "./data/transport.ts";
import { IpcClient } from "./ipc/client.ts";

async function boot(): Promise<void> {
  // The data layer binds to the host bridge BEFORE the tree mounts (the
  // plan: 唯一底层接线入口在传输层; every domain client flows through this).
  const { transport, label } = detectTransport();
  const client = new IpcClient(transport);
  bindAgentClient(transport);
  bindFileService(client);
  bindModelsService(client);
  bindSessionViewService(client);
  bindSessionListService(client);
  bindWorkspaceService(client);
  bindDesktopConnection(client);
  bindScheduledTasksStore(client);
  bindProjectTrustClient(client);
  bindStateMirrorClient(client);
  // The transition mirror imports BEFORE React mounts (plan §七.4): the
  // exported snapshot lands in localStorage while the UI still holds no
  // state of its own. Never invented when absent; never rolled back.
  await importStateMirrorBeforeMount(client).catch(() => null);
  if (label === "tauri") {
    // eslint-disable-next-line no-console
    console.info("[pi-desktop] static frontend booted on the Tauri IPC bridge");
  }

  const container = document.getElementById("root");
  if (container === null) throw new Error("static frontend: #root missing");

  createRoot(container).render(
    <StrictMode>
      <Suspense>
        <I18nProvider>
          <AppShell />
          <DistroSetupGate />
        </I18nProvider>
      </Suspense>
    </StrictMode>,
  );
}

void boot();
