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

import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { DistroSetupGate } from "@/components/distro";

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
