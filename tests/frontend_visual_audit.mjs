import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4175;
const baseUrl = `http://127.0.0.1:${port}`;
const reportPath = 'docs/frontend-visual-audit-2026-09-14.md';
const evidenceDir = 'artifacts/frontend-quality/visual-audit-2026-09-14';
let server;
let browser;

const results = {
  generatedAt: new Date().toISOString(),
  checks: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  notes: [],
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
  throw new Error('Visual audit server did not start');
};

const mockApi = async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/features') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      voice_enabled: true, presence_enabled: true, pro_model_enabled: true,
      memory_enabled: true, changelog_enabled: false, analytics_insights: true,
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
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"text":"Audit response."}\n\ndata: [DONE]\n\n' });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
};

const addCheck = (name, passed, detail) => {
  results.checks.push({ name, passed, detail });
  assert.equal(passed, true, `${name}: ${detail}`);
};

const clickHeaderAction = async (page, name) => {
  const desktop = page.getByRole('button', { name });
  if (await desktop.isVisible()) {
    await desktop.click();
    return;
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name }).click();
};

const auditPage = async (page, label, viewport) => {
  await page.setViewportSize(viewport);
  await page.route('**/api/**', mockApi);
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.goto(`${baseUrl}/index.html`);
  await page.getByPlaceholder('Ask MindPal').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_200);
  await clickHeaderAction(page, 'Toggle theme');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidenceDir}/${label}-initial.png`, fullPage: true });
  results.screenshots.push(`${label}-initial.png`);

  const geometry = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const controls = [...document.querySelectorAll('button, input, textarea, select, [role="button"]')]
      .filter((element) => {
        const style = getComputedStyle(element);
        return element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
      }));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: doc.scrollWidth,
      bodyWidth: body.scrollWidth,
      horizontalOverflow: doc.scrollWidth > window.innerWidth + 1 || body.scrollWidth > window.innerWidth + 1,
      controls,
      landmarks: [...document.querySelectorAll('main, nav, header, [role="dialog"], [role="log"]')].map((element) => element.getAttribute('role') || element.tagName.toLowerCase()),
    };
  });
  addCheck(`${label} has no horizontal overflow`, !geometry.horizontalOverflow, JSON.stringify(geometry));
  addCheck(`${label} has named visible controls`, geometry.controls.every((control) => control.ariaLabel || control.title || control.text), JSON.stringify(geometry.controls));
  addCheck(`${label} has main and navigation landmarks`, geometry.landmarks.includes('main') && geometry.landmarks.includes('nav'), JSON.stringify(geometry.landmarks));
  addCheck(`${label} has no empty-state ambient glow`, await page.locator('.ambient-canvas-glow').count() === 0, 'The empty chat state should not add a top aura.');
  addCheck(`${label} light theme is explicit`, await page.evaluate(() => document.documentElement.classList.contains('light') && !document.documentElement.classList.contains('dark')), 'Light mode must not rely on the OS fallback token set.');

  await clickHeaderAction(page, 'Open chat history');
  await page.getByRole('dialog', { name: 'Chat history' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  const historySearch = page.getByRole('textbox', { name: 'Search conversations' });
  await historySearch.fill('audit');
  addCheck(`${label} history removes New action`, await page.getByRole('button', { name: 'New', exact: true }).count() === 0, 'History should not show a New button.');
  addCheck(`${label} history uses text Clear`, await page.getByRole('button', { name: 'Clear search' }).count() === 1, 'Clear should be a text action.');
  addCheck(`${label} history separates Clear and close`, await page.locator('.h-5.w-px').count() >= 1, 'Clear and close should have a divider.');
  await page.screenshot({ path: `${evidenceDir}/${label}-history.png`, fullPage: true });
  results.screenshots.push(`${label}-history.png`);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Close history' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  const sidebarAccount = page.getByRole('button', { name: 'Account' });
  if (await sidebarAccount.isVisible()) {
    await sidebarAccount.click();
  } else {
    await page.getByRole('button', { name: 'Select settings category' }).click();
    await page.getByRole('menuitem', { name: 'Account' }).click();
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog', { name: 'Sign in to MindPal' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${evidenceDir}/${label}-auth.png`, fullPage: true });
  results.screenshots.push(`${label}-auth.png`);
  await page.getByRole('button', { name: 'Close sign-in' }).click();

  const focusOrder = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length && !element.hasAttribute('disabled'));
    return nodes.slice(0, 12).map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || (element.textContent || '').trim().slice(0, 40));
  });
  addCheck(`${label} has keyboard-focusable controls`, focusOrder.length >= 5, JSON.stringify(focusOrder));
  results.consoleErrors.push(...consoleErrors.map((message) => `${label}: ${message}`));
  results.pageErrors.push(...pageErrors.map((message) => `${label}: ${message}`));
  results.failedRequests.push(...failedRequests);

  await page.close();
};

before(async () => {
  await mkdir(evidenceDir, { recursive: true });
  server = spawn('python', ['-m', 'http.server', String(port), '--directory', 'frontend'], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  await waitForServer();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  results.summary = {
    checks: results.checks.length,
    passed: results.checks.filter((check) => check.passed).length,
    screenshots: results.screenshots.length,
    consoleErrors: results.consoleErrors.length,
    pageErrors: results.pageErrors.length,
    failedRequests: results.failedRequests.length,
  };
  const lines = [
    '# Frontend Visual and UX Audit',
    '',
    `Generated: ${results.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Checks: ${results.summary.passed}/${results.summary.checks} passed`,
    `- Screenshots: ${results.summary.screenshots}`, 
    `- Console errors: ${results.summary.consoleErrors}`,
    `- Page errors: ${results.summary.pageErrors}`,
    `- Failed requests: ${results.summary.failedRequests}`,
    '',
    '## Checks',
    '',
    ...results.checks.map((check) => `- ${check.passed ? '[x]' : '[ ]'} ${check.name}: ${check.detail}`),
    '',
    '## Evidence',
    '',
    ...results.screenshots.map((screenshot) => `- ${screenshot}`),
    '',
    '## Browser Errors',
    '',
    ...(results.consoleErrors.length ? results.consoleErrors.map((error) => `- Console: ${error}`) : ['- None']),
    ...(results.pageErrors.length ? results.pageErrors.map((error) => `- Page: ${error}`) : ['- No uncaught page errors']),
    ...(results.failedRequests.length ? results.failedRequests.map((request) => `- Request: ${request.url} (${request.error})`) : ['- No failed requests']),
    '',
    '## Interpretation',
    '',
    '- This audit proves the tested viewports and scenarios only; it does not claim every possible authenticated or destructive workflow is safe.',
    '- Destructive actions remain outside the automated pass and require isolated fixtures and explicit approval.',
  ];
  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  await writeFile('artifacts/frontend-quality/visual-audit-latest.json', `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  await browser?.close();
  server?.kill();
});

test('frontend visual and UX audit', async () => {
  const page = await browser.newPage();
  await auditPage(page, 'desktop-1280x900', { width: 1280, height: 900 });
  await auditPage(await browser.newPage(), 'mobile-390x844', { width: 390, height: 844 });
  assert.equal(results.consoleErrors.length, 0, results.consoleErrors.join('; '));
  assert.equal(results.pageErrors.length, 0, results.pageErrors.join('; '));
  assert.equal(results.failedRequests.length, 0, JSON.stringify(results.failedRequests));
});
