import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' } });
const { SystemPromptPanel } = await jiti.import('./SystemPromptPanel.tsx');
const render = props => renderToStaticMarkup(React.createElement(SystemPromptPanel, { loading: false, prompt: '', translate: key => key, ...props }));
test('unavailable record is never labelled not generated or tools disabled', () => {
  const html = render({ status: 'unknown' });
  assert.match(html, /system.unavailable/);
  assert.doesNotMatch(html, /system.notSent|toolsDisabled/);
});
test('recorded, configured and confirmed absent have distinct descriptions', () => {
  assert.match(render({ status: 'recorded', prompt: 'record' }), /system.noteRecorded/);
  assert.match(render({ status: 'configured', prompt: 'base' }), /system.noteConfigured/);
  assert.match(render({ status: 'none' }), /system.notSent/);
  assert.match(render({ status: 'unknown', loading: true }), /system.loading/);
});
