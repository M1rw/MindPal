import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const componentSources = {
  chatInput: 'frontend/src/components/chat/input/ChatInput.tsx',
  chatCanvas: 'frontend/src/components/chat/canvas/ChatCanvas.tsx',
  authModal: 'frontend/src/components/auth/AuthModal.tsx',
  settingsModal: 'frontend/src/components/settings/SettingsModal.tsx',
  historyModal: 'frontend/src/components/chat/history/ChatHistoryModal.tsx',
};

describe('Frontend component contracts', () => {
  it('keeps the chat input send contract explicit', async () => {
    const source = await readSource(componentSources.chatInput);
    assert.match(source, /export const ChatInput = forwardRef/);
    assert.match(source, /placeholder="Ask MindPal"/);
    assert.match(source, /ApiClient\.streamChat/);
    assert.match(source, /Please retry this message/);
  });

  it('keeps the chat canvas streaming and retry contracts explicit', async () => {
    const source = await readSource(componentSources.chatCanvas);
    assert.match(source, /role="log"/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /ChatCanvasMessage/);
    assert.match(source, /onRegenerate=\{handleRegenerate\}/);
  });

  it('keeps the auth modal dialog and focus contracts explicit', async () => {
    const source = await readSource(componentSources.authModal);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /useFocusTrap/);
    assert.match(source, /AuthChoiceView/);
    assert.match(source, /AuthEmailView/);
  });

  it('keeps the settings modal tabs and mobile selector contract explicit', async () => {
    const source = await readSource(componentSources.settingsModal);
    for (const tab of ['general', 'mental-health', 'features', 'voice', 'analytics', 'personalization', 'usage', 'data', 'security', 'account']) {
      assert.match(source, new RegExp(`id: '${tab}'`));
    }
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-label="Select settings category"/);
    assert.match(source, /AnalyticsSettingsTab/);
    assert.match(source, /UsageSettingsTab/);
  });

  it('keeps the history modal search, focus, and cloud recovery contract explicit', async () => {
    const source = await readSource(componentSources.historyModal);
    assert.match(source, /role="dialog"/);
    assert.match(source, /useFocusTrap/);
    assert.match(source, /Search conversations/);
    assert.match(source, /Cloud history unavailable/);
    assert.match(source, /Retry sync/);
  });
});
