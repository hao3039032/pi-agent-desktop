import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../hooks/useI18n';
import { SessionLoadNotice } from '../components/SessionLoadNotice';
import type { SessionLoadPhase } from '../lib/session-load';

function Fixture() {
  const [phase, setPhase] = useState<SessionLoadPhase>('opening');
  const [hasContent, setHasContent] = useState(false);
  return <main style={{ maxWidth: 800, margin: 'auto' }}>
    <nav aria-label="Test controls">
      {(['opening', 'slow', 'retrying', 'ready', 'failed'] as const).map(p =>
        <button key={p} onClick={() => setPhase(p)}>{p}</button>)}
      <button onClick={() => setHasContent(v => !v)}>cache</button>
    </nav>
    <SessionLoadNotice phase={phase} hasContent={hasContent} stale error={phase === 'failed' ? 'Request timed out after 65000ms' : null} onRetry={() => setPhase('opening')} />
    {hasContent && <article data-testid="history">已经显示的会话内容 / Existing conversation</article>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
