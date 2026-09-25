import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { serveStatic } from './static_server.mjs';
import { chromium } from 'playwright';

const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let browser;

const waitForServer = async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/index.html`);
      if (response.ok) return;
    } catch {
      // The static server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Frontend static server did not start');
};

before(async () => {
  server = await serveStatic('frontend', port);
  await waitForServer();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('chat send and stream completion happy path', async () => {
  const page = await browser.newPage();

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/features') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          voice_enabled: true,
          presence_enabled: true,
          pro_model_enabled: true,
          memory_enabled: true,
          changelog_enabled: false,
        }),
      });
      return;
    }
    if (path === '/api/greeting') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ greeting: 'Good morning', tone: 'warm', period: 'morning', cached: false }),
      });
      return;
    }
    if (path === '/api/release/changelog') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ product: 'MindPal', current_version: '5.0.0', entries: [] }),
      });
      return;
    }
    if (path === '/api/chat/stream') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"text":"I hear you. "}\n\ndata: {"text":"Let us take this one step at a time."}\n\ndata: [DONE]\n\n',
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${baseUrl}/index.html`);
  const input = page.getByPlaceholder('Ask MindPal');
  await input.waitFor({ state: 'visible' });
  await input.fill('I feel overwhelmed');
  await page.getByRole('button', { name: 'Send message' }).click();

  await page.getByText('I hear you. Let us take this one step at a time.', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByText('I feel overwhelmed', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Retry response' }).count(), 0);

  // Search (the command palette): opens from the header and from Ctrl/Cmd+K,
  // finds a chat by what was said, marks the match, and closes on Esc.
  await page.getByRole('button', { name: 'Search chats and actions' }).click();
  const palette = page.getByRole('dialog', { name: 'Search chats and actions' });
  await palette.waitFor({ state: 'visible' });
  await palette.getByRole('combobox').fill('overwhelmed');
  await palette.locator('mark.search-mark').first().waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await palette.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });

  // New chat asks through the app's confirm dialog, then clears the thread.
  await page.getByRole('button', { name: 'New chat' }).click();
  const confirm = page.getByRole('dialog', { name: 'Start a new chat?' });
  await confirm.waitFor({ state: 'visible' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('I feel overwhelmed', { exact: true }).count(), 1, 'cancel keeps the thread');
  await page.getByRole('button', { name: 'New chat' }).click();
  await confirm.getByRole('button', { name: 'New chat' }).click();
  // The sent message bubble goes (the empty state has a suggestion chip with the same words).
  await page.locator('.chat-user-bubble', { hasText: 'I feel overwhelmed' }).waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.waitFor({ state: 'visible' });
  await settingsDialog.getByRole('button', { name: 'Account' }).click();
  await settingsDialog.getByRole('button', { name: 'Sign in' }).click();
  const authDialog = page.getByRole('dialog', { name: 'Sign in to MindPal' });
  await authDialog.waitFor({ state: 'visible' });
  await authDialog.getByRole('button', { name: 'Continue with Email' }).click();
  await authDialog.getByRole('heading', { name: 'Continue with email' }).waitFor({ state: 'visible' });
  await authDialog.getByRole('button', { name: 'Close sign-in' }).click();

  await page.close();
});
