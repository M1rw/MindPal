import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const reportPath = 'artifacts/frontend-quality/latest.json';
let server;
let browser;

const report = {
  startedAt: new Date().toISOString(),
  baseUrl,
  viewport: { width: 1280, height: 900 },
  controls: [],
  attempted: [],
  skipped: [],
  events: [],
  requests: [],
  consoleErrors: [],
  pageErrors: [],
  failures: [],
  coverageGaps: [],
};

const waitForServer = async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Frontend quality server did not start');
};

const mockApi = async (route) => {
  const path = new URL(route.request().url()).pathname;
  report.requests.push({ method: route.request().method(), path });

  if (path === '/api/features') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      voice_enabled: true,
      presence_enabled: true,
      pro_model_enabled: true,
      memory_enabled: true,
      changelog_enabled: false,
      analytics_insights: true,
    }) });
    return;
  }
  if (path === '/api/greeting') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      greeting: 'Good morning', tone: 'warm', period: 'morning', cached: false,
    }) });
    return;
  }
  if (path === '/api/release/changelog') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      product: 'MindPal', current_version: '5.0.0', entries: [],
    }) });
    return;
  }
  if (path === '/api/chat/stream') {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"text":"Quality harness response."}\n\ndata: [DONE]\n\n',
    });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
};

const controlInventory = async (page) => page.locator('button, input, textarea, select, [role="button"]').evaluateAll((nodes) => nodes.map((node, index) => ({
  index,
  tag: node.tagName.toLowerCase(),
  role: node.getAttribute('role'),
  type: node.getAttribute('type'),
  ariaLabel: node.getAttribute('aria-label'),
  title: node.getAttribute('title'),
  text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  disabled: node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node.disabled : false,
  visible: Boolean(node.getClientRects().length),
})));

const labelFor = (control) => control.ariaLabel || control.title || control.text || `${control.tag}#${control.index}`;

const clickAndVerify = async (page, label, action) => {
  const before = await page.evaluate(() => window.__mindpalQualityEvents.length);
  report.attempted.push(label);
  await action();
  await page.waitForTimeout(50);
  const events = await page.evaluate(() => window.__mindpalQualityEvents);
  const clicked = events.slice(before).some((event) => event.type === 'click');
  if (!clicked) {
    report.failures.push(`No click event recorded for ${label}`);
  }
  assert.equal(clicked, true, `Expected click event for ${label}`);
}

before(async () => {
  await mkdir('artifacts/frontend-quality', { recursive: true });
  server = spawn('python', ['-m', 'http.server', String(port), '--directory', 'frontend'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForServer();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    controlsDiscovered: report.controls.length,
    actionsAttempted: report.attempted.length,
    actionsSkipped: report.skipped.length,
    eventsObserved: report.events.length,
    requestsObserved: report.requests.length,
    consoleErrors: report.consoleErrors.length,
    pageErrors: report.pageErrors.length,
    failures: report.failures.length,
    coverageGaps: report.coverageGaps.length,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await browser?.close();
  server?.kill();
});

test('frontend Tier-1 interaction quality harness', async () => {
  const page = await browser.newPage({ viewport: report.viewport });
  await page.addInitScript(() => {
    window.__mindpalQualityEvents = [];
    const record = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      window.__mindpalQualityEvents.push({
        type: event.type,
        tag: target?.tagName?.toLowerCase() || null,
        role: target?.getAttribute('role') || null,
        ariaLabel: target?.getAttribute('aria-label') || null,
        title: target?.getAttribute('title') || null,
        text: (target?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        value: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : undefined,
        timestamp: Date.now(),
      });
    };
    for (const type of ['click', 'input', 'change', 'keydown', 'submit']) {
      document.addEventListener(type, record, true);
    }
    window.addEventListener('error', (event) => {
      window.__mindpalQualityEvents.push({ type: 'window-error', message: event.message });
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__mindpalQualityEvents.push({ type: 'unhandled-rejection', message: String(event.reason) });
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.route('**/api/**', mockApi);

  await page.goto(`${baseUrl}/index.html`);
  await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
  report.controls = await controlInventory(page);

  const visibleControls = report.controls.filter((control) => control.visible && !control.disabled);
  assert.ok(visibleControls.length >= 8, `Expected a meaningful control surface, found ${visibleControls.length}`);

  for (const control of visibleControls) {
    if (!control.ariaLabel && !control.title && !control.text) {
      report.coverageGaps.push(`Interactive control ${control.tag}#${control.index} has no accessible name`);
    }
  }

  const destructive = /delete|forget|sign out|end voice|reload application/i;
  for (const control of visibleControls) {
    const label = labelFor(control);
    if (destructive.test(label)) {
      report.skipped.push({ label, reason: 'destructive action requires explicit scenario approval' });
    }
  }

  await clickAndVerify(page, 'New chat', () => page.getByRole('button', { name: 'New chat' }).click());
  await clickAndVerify(page, 'Toggle theme', () => page.getByRole('button', { name: 'Toggle theme' }).click());
  await clickAndVerify(page, 'View daily streak progress', async () => {
    await page.getByRole('button', { name: 'View daily streak progress' }).click();
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    const close = page.getByRole('button', { name: /close/i }).last();
    if (await close.count()) await close.click();
  });
  await clickAndVerify(page, 'Open chat history', async () => {
    await page.getByRole('button', { name: 'Open chat history' }).click();
    await page.getByRole('dialog', { name: 'Chat history' }).waitFor({ state: 'visible' });
  });
  await clickAndVerify(page, 'Clear history search', async () => {
    const search = page.getByRole('textbox', { name: 'Search conversations' });
    await search.fill('quality');
    await page.getByRole('button', { name: 'Clear search' }).click();
  });
  await clickAndVerify(page, 'Close chat history', () => page.getByRole('button', { name: 'Close history' }).click());
  await clickAndVerify(page, 'Open settings', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  });
  await clickAndVerify(page, 'Open sign-in', async () => {
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('dialog', { name: 'Sign in to MindPal' }).waitFor({ state: 'visible' });
  });
  await clickAndVerify(page, 'Open email auth', () => page.getByRole('button', { name: 'Continue with Email' }).click());
  await page.getByRole('heading', { name: 'Continue with email' }).waitFor({ state: 'visible' });
  await clickAndVerify(page, 'Close sign-in', () => page.getByRole('button', { name: 'Close sign-in' }).click());

  await clickAndVerify(page, 'Select model', async () => {
    await page.getByRole('button', { name: /Reply mode: Standard/ }).click();
    await page.getByRole('listbox', { name: 'Reply mode' }).waitFor({ state: 'visible' });
    await page.getByRole('listbox', { name: 'Reply mode' }).getByRole('option', { name: /Standard/ }).click();
  });

  const input = page.getByPlaceholder('Ask MindPal');
  await input.fill('Run quality interaction');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('Quality harness response.', { exact: true }).waitFor({ state: 'visible' });

  report.events = await page.evaluate(() => window.__mindpalQualityEvents);
  assert.equal(report.pageErrors.length, 0, `Unexpected page errors: ${report.pageErrors.join('; ')}`);
  assert.equal(report.failures.length, 0, report.failures.join('; '));
  assert.ok(report.events.some((event) => event.type === 'input'), 'Input events should be logged');
  assert.ok(report.events.some((event) => event.type === 'click'), 'Click events should be logged');
  assert.ok(report.events.some((event) => event.type === 'change' || event.type === 'click'), 'State changes should be observable');
  assert.equal(report.coverageGaps.length, 0, report.coverageGaps.join('; '));

  await page.close();
});
