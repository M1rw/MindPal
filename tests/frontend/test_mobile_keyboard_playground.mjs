import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveStatic } from './static_server.mjs';

const port = 4186;
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let browser;

test.before(async () => {
  server = await serveStatic('tests/fixtures', port);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/mobile_keyboard_playground.html`)).ok) break;
    } catch {
      // Wait for the fixture server.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('iOS keyboard simulation pins the composer to the keyboard top', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await page.goto(`${baseUrl}/mobile_keyboard_playground.html`);
  await page.locator('#chat-input').focus();
  await page.evaluate(() => window.simulateIOSKeyboard(510));
  await page.waitForTimeout(50);

  const geometry = await page.evaluate(() => window.getGeometry());
  assert.equal(geometry.keyboardOffset, '334px');
  assert.equal(geometry.dockPosition, 'fixed');
  assert.equal(geometry.dockBottom, '334px');
  assert.equal(geometry.dockTransform, 'none');
  assert.ok(Math.abs(geometry.composerBottom - geometry.keyboardTop) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.lastMessageBottom <= geometry.composerTop, JSON.stringify(geometry));
  assert.ok(geometry.composerTop - geometry.lastMessageBottom <= 48, JSON.stringify(geometry));

  for (const height of [620, 740, 844, 560]) {
    await page.evaluate((nextHeight) => window.simulateIOSKeyboard(nextHeight), height);
    const moved = await page.evaluate(() => window.getGeometry());
    assert.ok(Math.abs(moved.composerBottom - moved.keyboardTop) <= 1, JSON.stringify(moved));
  }

  await page.screenshot({ path: 'artifacts/frontend-quality/mobile-keyboard-playground.png', fullPage: true });
  await page.close();
});
