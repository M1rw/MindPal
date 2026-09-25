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
import { serveStatic } from './static_server.mjs';
import { chromium, devices, webkit } from 'playwright';

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;

/** A 1x1 PNG and a one-page PDF with a real text layer (enough to exercise both pipelines). */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 180>>stream
BT /F1 12 Tf 20 150 Td (The tenant pays a security deposit of 1450 dollars, refundable within thirty days after moving out.) Tj 0 -20 Td (Pets: one cat is allowed for a small monthly fee.) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`,
);

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
  server = await serveStatic('frontend', port);
  await waitForServer();
});

after(async () => {
  for (const browser of browsers.values()) await browser.close();
  await server?.close();
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
    // Files (v5.0.5): a guest's limits, and readings that echo what was sent.
    if (path === '/api/files/allowance') {
      return json({
        files_used: 0, files_limit: 5, vision_pages_used: 0, vision_pages_limit: 20, max_image_bytes: 10_000_000,
        max_pdf_bytes: 10_000_000, max_pdf_pages: 10, library_files: 10, library_bytes: 0, library_days: 7,
        max_attachments: 4, signed_in: false,
      });
    }
    if (path === '/api/files/digest/image') {
      return json({ digest: { version: 1, kind: 'image', content: 'visual', name: 'photo.jpg', title: 'A test photo', summary: 'A test photo', language: '', total_pages: 1, pages: [{ n: 1, kind: 'visual', text: '', description: 'A test photo' }] } });
    }
    if (path === '/api/files/digest/pages') {
      const body = JSON.parse(route.request().postData() || '{}');
      return json({ pages: body.pages.map((p) => ({ n: p.n, kind: 'text', text: p.text || 'scanned', description: '' })) });
    }
    if (path === '/api/files/digest/assemble') {
      const body = JSON.parse(route.request().postData() || '{}');
      return json({ digest: { version: 1, kind: 'pdf', content: 'text', name: body.name, title: body.name, summary: '', language: '', total_pages: body.total_pages, pages: body.pages } });
    }
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
      // Poll until the layout stops moving (slow CI runners take longer than a desktop).
      let last = null;
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const bottom = Math.round(document.querySelector('.chat-composer').getBoundingClientRect().bottom);
        if (bottom === last) break;
        last = bottom;
      }
      const composer = document.querySelector('.chat-composer').getBoundingClientRect();
      const css = getComputedStyle(document.documentElement);
      return {
        top: composer.top,
        bottom: composer.bottom,
        visibleTop: pan,
        visibleBottom: pan + height,
        debug: {
          appHeight: css.getPropertyValue('--app-height'),
          vvTop: css.getPropertyValue('--vv-top'),
          vvHeight: window.visualViewport?.height,
          innerHeight: window.innerHeight,
          shell: document.querySelector('.app-shell')?.getBoundingClientRect().height,
          stage: document.querySelector('.chat-stage')?.className,
          rows: document.querySelector('.chat-stage') && getComputedStyle(document.querySelector('.chat-stage')).gridTemplateRows,
          dock: [...(document.querySelector('.chat-composer-dock')?.children || [])].map(
            (el) => `${String(el.className).split(' ')[0]}:${Math.round(el.getBoundingClientRect().top)}+${Math.round(el.getBoundingClientRect().height)}`,
          ),
          composerTop: Math.round(composer.top),
          scrollY: window.scrollY,
          stageScroll: document.querySelector('.chat-stage')?.scrollTop,
          shellScroll: document.querySelector('.app-shell')?.scrollTop,
          shellTop: Math.round(document.querySelector('.app-shell')?.getBoundingClientRect().top ?? NaN),
          stageTop: Math.round(document.querySelector('.chat-stage')?.getBoundingClientRect().top ?? NaN),
          dockBox: (() => { const r = document.querySelector('.chat-composer-dock')?.getBoundingClientRect(); return r && [Math.round(r.top), Math.round(r.height)]; })(),
          dockPos: document.querySelector('.chat-composer-dock') && getComputedStyle(document.querySelector('.chat-composer-dock')).position,
          docH: document.documentElement.scrollHeight,
        },
      };
    },
    { keyboard, pan },
  );
}

describe('camera (Chromium, fake camera)', () => {
  const pixel = PROFILES.find((p) => p.name.startsWith('Pixel'));

  async function cameraApp(permissions) {
    const browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    const context = await browser.newContext({ ...pixel.device, permissions });
    const page = await context.newPage();
    await mockApi(page);
    await page.goto(`${baseUrl}/index.html`);
    await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
    return { browser, page };
  }

  async function openCamera(page) {
    await page.getByRole('button', { name: 'Add files or a photo' }).tap();
    await page.getByRole('menuitem', { name: /Take photo/ }).tap();
    const sheet = page.getByRole('dialog', { name: 'Camera' });
    await sheet.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector('.camera-sheet__video');
      return video && video.videoWidth > 0 && !document.querySelector('.camera-sheet__shutter')?.disabled;
    });
    return sheet;
  }

  test('take photos in the app: a 3:4 frame, a tray, Document mode; they land in the composer', async () => {
    const { browser, page } = await cameraApp(['camera']);
    try {
      const sheet = await openCamera(page);
      await assertNoSideways(page, 'camera');
      const frame = await page.locator('.camera-sheet__frame').boundingBox();
      assert.ok(Math.abs(frame.width / frame.height - 3 / 4) < 0.02, `a 3:4 viewfinder on a phone, got ${frame.width}x${frame.height}`);
      const bottom = await page.locator('.camera-sheet__shutter').boundingBox();
      assert.ok(bottom.y + bottom.height <= pixel.device.viewport.height, 'the shutter is on screen');

      await page.getByRole('button', { name: 'Take photo' }).tap();
      await page.getByRole('button', { name: 'Review 1 photo' }).waitFor();
      await page.getByRole('radio', { name: 'Document' }).tap();
      await page.getByRole('button', { name: 'Take photo' }).tap();
      await page.getByRole('button', { name: 'Review 2 photos' }).waitFor();

      // Review: delete one, keep the other.
      await page.getByRole('button', { name: 'Review 2 photos' }).tap();
      await page.getByRole('img', { name: 'Selected photo' }).waitFor();
      const size = await page.getByRole('img', { name: 'Selected photo' }).evaluate((img) => [img.naturalWidth, img.naturalHeight]);
      assert.ok(Math.abs(size[0] / size[1] - 3 / 4) < 0.01, `the photo is what was framed, got ${size}`);
      await page.getByRole('button', { name: 'Delete this photo' }).tap();
      await page.getByRole('button', { name: 'Keep shooting' }).tap();
      await page.getByRole('button', { name: 'Take photo' }).tap();
      await page.getByRole('button', { name: 'Add 2 photos' }).first().tap();
      await sheet.waitFor({ state: 'detached' });
      await page.locator('.composer-file--image').nth(1).waitFor();
      assert.equal(await page.locator('.composer-file--image').count(), 2);
      assert.equal(await page.evaluate(() => document.querySelector('.camera-sheet__video')), null, 'camera released');
    } finally {
      await browser.close();
    }
  });

  test('switching camera lets go of the first before asking for the second (iOS allows one)', async () => {
    const { browser, page } = await cameraApp(['camera']);
    try {
      await page.evaluate(() => {
        const media = navigator.mediaDevices;
        const real = media.getUserMedia.bind(media);
        const live = [];
        window.__overlap = 0;
        window.__requests = [];
        media.getUserMedia = async (constraints) => {
          if (live.some((track) => track.readyState === 'live')) window.__overlap += 1;
          window.__requests.push(constraints.video.facingMode.ideal);
          const stream = await real(constraints);
          live.push(...stream.getTracks());
          return stream;
        };
        media.enumerateDevices = async () => [
          { kind: 'videoinput', deviceId: 'back', label: 'Back', groupId: 'a' },
          { kind: 'videoinput', deviceId: 'front', label: 'Front', groupId: 'b' },
        ];
      });
      await openCamera(page);
      const flip = page.getByRole('button', { name: 'Switch camera' });
      await flip.tap();
      await page.locator('.camera-sheet--front').waitFor();
      await page.waitForFunction(() => document.querySelector('.camera-sheet__video.is-live'));
      await flip.tap();
      await page.waitForFunction(() => window.__requests.length === 3 && document.querySelector('.camera-sheet__video.is-live'));
      assert.deepEqual(await page.evaluate(() => window.__requests), ['environment', 'user', 'environment']);
      assert.equal(await page.evaluate(() => window.__overlap), 0, 'never two cameras at once');
    } finally {
      await browser.close();
    }
  });

  test('camera access refused: a clear message and the phone camera app instead', async () => {
    const { browser, page } = await cameraApp([]);
    try {
      await page.evaluate(() => {
        // What a refused permission looks like to the page.
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
      await page.getByRole('button', { name: 'Add files or a photo' }).tap();
      await page.getByRole('menuitem', { name: /Take photo/ }).tap();
      await page.getByRole('alert').getByText('Camera access is off', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Use the camera app' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Take photo' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Close camera' }).tap();
      await page.getByRole('dialog', { name: 'Camera' }).waitFor({ state: 'detached' });
    } finally {
      await browser.close();
    }
  });
});

/** A reply long enough to scroll away from, so "Jump to latest" appears. */
async function withLongReply(page) {
  const text = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: a longer thought that fills the screen.`).join(' ');
  await page.route('**/api/chat/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"text":"${text}"}

data: [DONE]

` }),
  );
  await page.getByPlaceholder('Ask MindPal').fill('tell me a lot');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('Paragraph 120:', { exact: false }).waitFor();
  await page.evaluate(async () => {
    for (const animation of document.querySelector('.chat-composer-dock')?.getAnimations() ?? []) animation.finish();
    document.querySelector('#chat-canvas').scrollTo({ top: 0 });
  });
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await jump.waitFor();
  await page.waitForTimeout(300); // entrance animation
  return jump;
}

async function jumpGeometry(page) {
  return page.evaluate(() => {
    const button = document.querySelector('.chat-jump-latest').getBoundingClientRect();
    const dock = document.querySelector('.chat-composer-dock').getBoundingClientRect();
    const label = document.querySelector('.chat-jump-latest__label');
    return {
      width: button.width,
      height: button.height,
      gap: dock.top - button.bottom,
      centre: button.left + button.width / 2 - window.innerWidth / 2,
      labelShown: getComputedStyle(label).display !== 'none',
    };
  });
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
        await page.locator('.chat-stage--thread').waitFor({ state: 'attached' });
        // The composer glides from the centred home position to the bottom
        // (AppPanels FLIP, 420ms). Headless WebKit on a slow runner may not
        // advance it, so finish it before measuring the keyboard layout.
        await page.evaluate(async () => {
          const dock = document.querySelector('.chat-composer-dock');
          for (const animation of dock?.getAnimations() ?? []) animation.finish();
        });
        await page.getByPlaceholder('Ask MindPal').focus();

        const keyboard = Math.round(page.viewportSize().height * 0.42);
        for (const pan of [0, 90]) {
          const g = await withKeyboard(page, { keyboard, pan });
          const why = JSON.stringify(g.debug);
          assert.ok(g.bottom <= g.visibleBottom + 1, `pan ${pan}: composer hidden behind the keyboard (${g.bottom} > ${g.visibleBottom}) ${why}`);
          assert.ok(g.bottom >= g.visibleBottom - 80, `pan ${pan}: composer floats ${Math.round(g.visibleBottom - g.bottom)}px above the keyboard ${why}`);
          assert.ok(g.top >= g.visibleTop, `pan ${pan}: composer pushed above the visible area`);
        }
      } finally {
        await context.close();
      }
    });

    test('home keeps greeting, chips and composer centred as one group, even for a long greeting', async () => {
      const { context, page } = await openApp(profile);
      try {
        for (const text of ['Good afternoon, Maven.', 'Good afternoon, Maven. How did the Chichi TikTok trend turn out for you?']) {
          await page.evaluate((t) => {
            document.querySelector('h1').textContent = t;
          }, text);
          await page.waitForTimeout(200);
          // Measure the settled layout: a slow runner can still be mid-reveal.
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => {})),
            ),
          );
          const g = await page.evaluate(() => {
            const top = document.querySelector('h1').getBoundingClientRect().top;
            // The group ends with the caption under the composer (the dock).
            const bottom = document.querySelector('.chat-composer-dock').getBoundingClientRect().bottom;
            const areaTop = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
            return { above: top - areaTop, below: window.innerHeight - bottom };
          });
          // 12px floor: on the 320x568 first iPhone SE a two-line greeting settles 16-17px
          // under the header (measured on main too), which reads fine; under 12 it crowds.
          assert.ok(g.above >= 12, `greeting hidden under or crowding the header (${Math.round(g.above)}px) for "${text}"`);
          // Balanced: at most a small optical lift, never the old "pinned to the top".
          assert.ok(g.above >= g.below * 0.6 - 8, `group pushed up: ${Math.round(g.above)}px above vs ${Math.round(g.below)}px below for "${text}"`);
        }
      } finally {
        await context.close();
      }
    });

    test('files: attach a photo and a PDF, send, open the viewer and the library, all on screen', async () => {
      const { context, page, problems } = await openApp(profile);
      try {
        // The "+" opens its menu above the composer, even with the keyboard up.
        await withKeyboard(page, { keyboard: 300 });
        await page.getByRole('button', { name: 'Add files or a photo' }).tap();
        const menu = page.getByRole('menu', { name: 'Add to your message' });
        await menu.waitFor({ state: 'visible' });
        const menuBox = await menu.boundingBox();
        const visibleBottom = await page.evaluate(() => window.visualViewport.height);
        assert.ok(menuBox.y + menuBox.height <= visibleBottom + 1, 'the attach menu sits above the keyboard');
        await assertTapTargets(page, '.composer-attach-menu', 'attach menu');
        await page.keyboard.press('Escape');

        // A photo and a 3-page PDF, as the file picker would hand them over.
        await page.setInputFiles('[data-testid="composer-file-input"]', [
          { name: 'photo.png', mimeType: 'image/png', buffer: PNG_1PX },
          { name: 'notes.pdf', mimeType: 'application/pdf', buffer: TINY_PDF },
        ]);
        await page.locator('.composer-file--pdf').getByText(/1 page/).waitFor({ timeout: 15_000 });
        await page.locator('.composer-file--image').waitFor();
        await page.waitForFunction(() => !document.querySelector('.composer-file__veil'));
        await assertNoSideways(page, 'composer with files');
        await assertTapTargets(page, '.composer-files', 'file chips', 20);

        // A file alone is a message.
        await page.getByRole('button', { name: 'Send message' }).tap();
        await page.locator('.msg-file-pdf').waitFor();
        await page.getByText('Stuck like one decision, or more of a fog?').first().waitFor();
        await assertNoSideways(page, 'thread with files');

        // The PDF opens in the viewer, drawn by pdf.js. The thread settles first
        // (thumbnails load and it keeps to the bottom), then the card is tapped
        // near its corner: on a small phone "Jump to latest" can sit over its centre.
        await page.waitForFunction(() => [...document.querySelectorAll('.msg-files img')].every((img) => img.complete));
        // The thread re-mounts once the chat gets its id: retry if the card was swapped out mid-tap.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await page.waitForTimeout(400);
          try {
            await page.locator('.msg-file-pdf').tap({ position: { x: 16, y: 16 }, timeout: 3_000 });
            if (await page.locator('.file-viewer').count()) break;
          } catch {
            /* swapped out: try again */
          }
        }
        await page.locator('.file-viewer__page canvas.is-drawn').first().waitFor({ timeout: 15_000 });
        assert.match(await page.locator('.file-viewer__bar').innerText(), /Page 1 of 1/);
        await assertNoSideways(page, 'viewer');
        await page.getByRole('button', { name: 'Close viewer' }).tap();

        // The guest library shows both files, kept on this device.
        await page.evaluate(() => {
          document.querySelector('[aria-label="More actions"]')?.click();
        });
        const libraryItem = page.getByRole('menuitem', { name: 'Open your library' });
        if (await libraryItem.count()) await libraryItem.tap();
        else await page.evaluate(() => window.dispatchEvent(new Event('mindpal:open-library')));
        await page.getByText('Kept on this device for 7 days.', { exact: false }).waitFor();
        await page.locator('.library-card').nth(1).waitFor();
        await assertNoSideways(page, 'library');
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test('jump to latest: a round arrow right above the composer that stays put as it grows', async () => {
      const { context, page, problems } = await openApp(profile);
      try {
        const jump = await withLongReply(page);
        const g = await jumpGeometry(page);
        assert.equal(g.labelShown, false, 'phones show only the arrow');
        assert.ok(Math.abs(g.width - g.height) < 1 && g.width >= 40, `a round thumb-sized button, got ${g.width}x${g.height}`);
        assert.ok(g.gap >= 4 && g.gap <= 24, `sits just above the composer, gap ${g.gap}px`);
        assert.ok(Math.abs(g.centre) < 2, 'centred');

        // A taller composer (several lines) must not leave it floating or overlapping.
        await page.getByPlaceholder('Ask MindPal').fill('one\ntwo\nthree\nfour');
        await page.waitForTimeout(400);
        const grown = await jumpGeometry(page);
        assert.ok(grown.gap >= 4 && grown.gap <= 24, `still just above the grown composer, gap ${grown.gap}px`);

        await jump.tap();
        await jump.waitFor({ state: 'detached' });
        // A smooth scroll: give it time to arrive.
        await page.waitForFunction(() => {
          const el = document.querySelector('#chat-canvas');
          return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }, null, { timeout: 3_000 }).catch(() => {});
        const left = await page.evaluate(() => {
          const el = document.querySelector('#chat-canvas');
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        });
        assert.ok(left < 96, `scrolled to the latest, ${left}px left`);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test('header: the Chat/Presence tabs fit beside the name and buttons, and switch by tap', async () => {
      const { context, page, problems } = await openApp(profile);
      try {
        const tabs = page.getByRole('tablist', { name: 'MindPal modes' });
        await tabs.waitFor();
        await page.waitForTimeout(400);
        const fit = async () => page.evaluate(() => {
          const [logo, group, nav] = document.querySelector('#header > div').children;
          const b = (el) => el.getBoundingClientRect();
          const buttons = [...group.querySelectorAll('[role="tab"]')];
          return {
            logoClipped: logo.scrollWidth > b(logo).width + 1,
            overlap: b(logo).right > b(group).left + 1 || b(group).right > b(nav).left + 1,
            spill: buttons.filter((tab) => tab.scrollWidth > b(tab).width + 1).map((tab) => tab.id),
          };
        });
        assert.deepEqual(await fit(), { logoClipped: false, overlap: false, spill: [] });
        await tabs.getByRole('tab', { name: 'Presence' }).tap();
        await page.locator('#tab-presence[aria-selected="true"]').waitFor();
        await page.waitForTimeout(400);
        assert.deepEqual(await fit(), { logoClipped: false, overlap: false, spill: [] }, 'still fits with Presence selected');
        await tabs.getByRole('tab', { name: 'Chat' }).tap();
        await page.locator('#tab-chat[aria-selected="true"]').waitFor();
        assert.deepEqual(problems, []);
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

test('jump to latest on a big screen: a labelled pill', async () => {
  const browser = await browserFor(chromium);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await mockApi(page);
    await page.goto(`${baseUrl}/index.html`);
    await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
    await withLongReply(page);
    const g = await jumpGeometry(page);
    assert.equal(g.labelShown, true, 'desktop says "Jump to latest"');
    assert.ok(g.width > g.height * 2, 'a pill, not a circle');
    assert.ok(g.gap >= 4 && g.gap <= 24, `just above the composer, gap ${g.gap}px`);
  } finally {
    await context.close();
  }
});

test('what you type before the feature flags arrive survives them (the chat is not re-created)', async () => {
  const profile = PROFILES[0];
  const browser = await browserFor(profile.engine);
  const context = await browser.newContext({ ...profile.device });
  const page = await context.newPage();
  try {
    await mockApi(page);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/features', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ voice_enabled: true, presence_enabled: true }) });
    });
    await page.goto(`${baseUrl}/index.html`);
    const composer = page.getByPlaceholder('Ask MindPal');
    await composer.waitFor({ state: 'visible' });
    await composer.fill('typed early');
    const before = await page.evaluate(() => { window.__stage = document.querySelector('.chat-stage'); return true; });
    release();
    await page.getByRole('tablist', { name: 'MindPal modes' }).waitFor();
    assert.ok(before);
    assert.equal(await composer.inputValue(), 'typed early', 'the draft survives');
    assert.equal(await page.evaluate(() => window.__stage === document.querySelector('.chat-stage')), true, 'same chat, not re-created');
  } finally {
    await context.close();
  }
});
