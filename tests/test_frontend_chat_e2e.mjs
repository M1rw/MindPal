import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  server = spawn('python', ['-m', 'http.server', String(port), '--directory', 'frontend'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForServer();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill();
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

  await page.getByRole('button', { name: 'Open chat history' }).click();
  await page.getByRole('dialog', { name: 'Chat history' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close history' }).click();

  await page.getByRole('button', { name: 'Sign in to sync' }).click();
  const authDialog = page.getByRole('dialog', { name: 'Back up your MindPal' });
  await authDialog.waitFor({ state: 'visible' });
  await authDialog.getByRole('button', { name: 'Continue with Email' }).click();
  await authDialog.getByRole('heading', { name: 'Continue with email' }).waitFor({ state: 'visible' });
  await authDialog.getByRole('button', { name: 'Close sign-in' }).click();

  await page.close();
});
