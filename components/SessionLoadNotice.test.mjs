import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, alias: { '@': process.cwd() } });
const { SessionLoadNotice } = await jiti.import('./SessionLoadNotice.tsx');
const { I18nProvider } = await jiti.import('@/hooks/useI18n');
const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(SessionLoadNotice, { onRetry() {}, error: null, ...props })));

test('initial failure uses localized recovery text and collapsed diagnostics', () => {
  const html = render({ phase: 'failed', hasContent: false, error: 'Request Timeout <secret>' });
  assert.match(html, /session-load-title/);
  assert.doesNotMatch(html.match(/session-load-title[^>]*>([^<]*)/)[1], /Timeout/);
  assert.match(html, /<details class="session-load-diagnostics">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /Request Timeout &lt;secret&gt;/);
  assert.match(html, /session-load-retry/);
});

test('opening, slow and automatic retry are busy progress, not error/retry buttons', () => {
  for (const phase of ['opening', 'slow', 'retrying']) {
    const html = render({ phase, hasContent: false });
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /<button|<details/);
  }
});

test('cached syncing and failed refresh are inline; healthy background reads stay quiet', () => {
  assert.equal(render({ phase: 'ready', hasContent: true }), '');
  assert.equal(render({ phase: 'opening', hasContent: true }), '');
  assert.match(render({ phase: 'opening', hasContent: true, stale: true }), /is-inline/);
  assert.match(render({ phase: 'failed', hasContent: true, error: 'offline' }), /is-inline/);
  const source = readFileSync(new URL('./ChatWindow.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(error && !data && messages\.length === 0 && !streamState\.isStreaming\)/);
  assert.doesNotMatch(source, /if \(error\)\s*\{/);
});
