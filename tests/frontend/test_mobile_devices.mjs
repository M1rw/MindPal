/**
 * MindPal on phones: real WebKit (the engine inside every iOS browser) with
 * iPhone profiles, and Chromium with an Android profile, against the built app.
 *
 * Emulation, not a device farm: it cannot open a real on-screen keyboard or
 * render the notch. So the keyboard is simulated the way iOS reports it (the
 * visual viewport shrinks and may pan while innerHeight stays put), and every
 * check here is a layout or behaviour fact, not a pixel comparison.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, devices, webkit } from 'playwright';

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;

const PROFILES = [
  { name: 'iPhone 15 (WebKit)', engine: webkit, device: devices['iPhone 15'] },
  { name: 'iPhone SE (WebKit)', engine: webkit, device: devices['iPhone SE'] },
  { name: 'Pixel 7 (Chromium)', engine: chromium, device: devices['Pixel 7'] },
];

let server;
const browsers = new Map();

async function waitForServer() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/index.html`)).ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Frontend static server did not start');
}

before(async () => {
  server = spawn('python', ['-m', 'http.server', String(port), '--directory', 'frontend'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForServer();
});

after(async () => {
  for (const browser of browsers.values()) await browser.close();
  server?.kill();
});

async function browserFor(engine) {
  if (!browsers.has(engine)) browsers.set(engine, await engine.launch({ headless: true }));
  return browsers.get(engine);
}

async function mockApi(page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/features') {
      return json({ voice_enabled: true, presence_enabled: true, pro_model_enabled: true, memory_enabled: true, changelog_enabled: false });
    }
    if (path === '/api/greeting') return json({ greeting: 'Good morning', tone: 'warm', period: 'morning', cached: false });
    if (path === '/api/release/changelog') return json({ product: 'MindPal', current_version: '5.0.0', entries: [] });
    if (path === '/api/chat/stream') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"text":"Stuck like one decision, or more of a fog?"}\n\ndata: [DONE]\n\n',
      });
    }
    return json({});
  });
}

async function openApp(profile) {
  const browser = await browserFor(profile.engine);
  const context = await browser.newContext({ ...profile.device });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // Safari ignores the viewport key Android Chrome needs for resizes-content.
    if (message.text().includes('"interactive-widget" not recognized')) return;
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  await mockApi(page);
  await page.goto(`${baseUrl}/index.html`);
  await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
  return { context, page, problems };
}

/** Nothing on the page is wider than the screen (the classic mobile glitch). */
async function assertNoSideways(page, where) {
  await page.waitForTimeout(500); // let open/close and composer morphs finish
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    const root = document.scrollingElement;
    const outside = (r) => r.right > width + 1 || r.left < -1;
    // Hidden by an ancestor that clips and itself fits: not visible, not a bug.
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(hidden|clip|auto|scroll)/.test(s.overflowX) && !outside(a.getBoundingClientRect())) return true;
      }
      return false;
    };
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && style.visibility !== 'hidden' && outside(r) && style.position !== 'fixed' && !clipped(el);
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`);
    return { scrollWidth: root.scrollWidth, width, wide };
  });
  assert.ok(overflow.scrollWidth <= overflow.width + 1, `${where}: page scrolls sideways (${overflow.scrollWidth} > ${overflow.width})`);
  assert.deepEqual(overflow.wide, [], `${where}: elements poke past the screen edge`);
}

/** Every visible button is big enough to hit with a thumb. */
async function assertTapTargets(page, scope, where, min = 36) {
  const small = await page.evaluate(
    ({ selector, min }) =>
      [...document.querySelectorAll(`${selector} button, ${selector} [role="button"]`)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.width < min || r.height < min);
        })
        .map((el) => `${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`),
    { selector: scope, min },
  );
  assert.deepEqual(small, [], `${where}: tap targets under ${min}px`);
}

/** Simulate the on-screen keyboard as iOS reports it and return composer geometry. */
async function withKeyboard(page, { keyboard, pan = 0 }) {
  return page.evaluate(
    async ({ keyboard, pan }) => {
      const height = window.innerHeight - keyboard;
      const fake = { height, width: window.innerWidth, offsetTop: pan, offsetLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
      Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const composer = document.querySelector('.chat-composer').getBoundingClientRect();
      return { top: composer.top, bottom: composer.bottom, visibleTop: pan, visibleBottom: pan + height };
    },
    { keyboard, pan },
  );
}

for (const profile of PROFILES) {
  describe(profile.name, () => {
    test('home, chat, search, settings and confirm fit the screen and work by touch', async () => {
      const { context, page, problems } = await openApp(profile);
      try {
        await assertNoSideways(page, 'home');
        const fontSize = await page.getByPlaceholder('Ask MindPal').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        assert.ok(fontSize >= 16, `composer text is ${fontSize}px; under 16px makes iOS zoom in on focus`);
        await assertTapTargets(page, 'header', 'header');

        // Send by tapping, like a person would.
        await page.getByPlaceholder('Ask MindPal').tap();
        await page.getByPlaceholder('Ask MindPal').fill('I feel stuck');
        await page.getByRole('button', { name: 'Send message' }).tap();
        await page.getByText('Stuck like one decision, or more of a fog?').first().waitFor({ state: 'visible' });
        await assertNoSideways(page, 'chat');

        // Search palette.
        // Phones reach search through the header's "More actions" menu.
        const direct = page.getByRole('button', { name: 'Search chats and actions' });
        if (await direct.isVisible()) {
          await direct.tap();
        } else {
          await page.getByRole('button', { name: 'More actions' }).first().tap();
          await page.getByRole('menuitem', { name: 'Search chats and actions' }).tap();
        }
        const palette = page.getByRole('dialog', { name: 'Search chats and actions' });
        await palette.waitFor({ state: 'visible' });
        await assertNoSideways(page, 'search');
        const box = await palette.boundingBox();
        const viewport = page.viewportSize();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, 'search fits the screen width');
        await palette.getByRole('combobox').fill('stuck');
        await palette.locator('mark.search-mark').first().waitFor({ state: 'visible' });
        await palette.getByRole('button', { name: /close/i }).first().tap();
        await palette.waitFor({ state: 'hidden' });

        // New chat asks first; both buttons fit and are the same size.
        await page.getByRole('button', { name: 'New chat' }).first().tap();
        const confirm = page.getByRole('dialog', { name: 'Start a new chat?' });
        await confirm.waitFor({ state: 'visible' });
        await assertNoSideways(page, 'confirm');
        const cancel = await confirm.getByRole('button', { name: 'Cancel' }).boundingBox();
        const ok = await confirm.getByRole('button', { name: 'New chat' }).boundingBox();
        assert.ok(Math.abs(cancel.height - ok.height) < 1 && cancel.height >= 40, 'confirm buttons match and are thumb-sized');
        assert.ok(ok.x + ok.width <= viewport.width, 'confirm button is on screen');
        await confirm.getByRole('button', { name: 'Cancel' }).tap();
        await confirm.waitFor({ state: 'hidden' });

        assert.deepEqual(problems, [], 'no page errors or console errors');
      } finally {
        await context.close();
      }
    });

    test('the composer sits right above the keyboard, also when iOS pans the page', async () => {
      const { context, page } = await openApp(profile);
      try {
        await page.getByPlaceholder('Ask MindPal').fill('hi');
        await page.getByRole('button', { name: 'Send message' }).tap();
        await page.getByText('Stuck like one decision, or more of a fog?').first().waitFor({ state: 'visible' });
        await page.getByPlaceholder('Ask MindPal').focus();

        const keyboard = Math.round(page.viewportSize().height * 0.42);
        for (const pan of [0, 90]) {
          const g = await withKeyboard(page, { keyboard, pan });
          assert.ok(g.bottom <= g.visibleBottom + 1, `pan ${pan}: composer hidden behind the keyboard (${g.bottom} > ${g.visibleBottom})`);
          assert.ok(g.bottom >= g.visibleBottom - 80, `pan ${pan}: composer floats ${Math.round(g.visibleBottom - g.bottom)}px above the keyboard`);
          assert.ok(g.top >= g.visibleTop, `pan ${pan}: composer pushed above the visible area`);
        }
      } finally {
        await context.close();
      }
    });

    test('an installed app (home-screen / standalone) is detected', async () => {
      const browser = await browserFor(profile.engine);
      const context = await browser.newContext({ ...profile.device });
      await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
      const page = await context.newPage();
      try {
        await mockApi(page);
        await page.goto(`${baseUrl}/index.html`);
        await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => document.body.classList.contains('standalone')), true);
        await assertNoSideways(page, 'standalone home');
      } finally {
        await context.close();
      }
    });
  });
}
