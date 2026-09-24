/**
 * Dictation end to end in a real browser: Chromium's fake microphone plays a
 * real voice note (Arabic and English in one sentence, tests/fixtures/speech),
 * the app records it and posts the audio to /api/transcribe, and the
 * transcript lands in the composer.
 *
 * The transcription service itself is mocked here (CI has no provider keys);
 * `MINDPAL_DICTATION_LIVE=1 BASE_URL=http://127.0.0.1:8765` runs the same
 * flow against a real backend, where Whisper hears the audio.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const live = process.env.MINDPAL_DICTATION_LIVE === '1';
const port = 4177;
const baseUrl = live ? process.env.BASE_URL || 'http://127.0.0.1:8765' : `http://127.0.0.1:${port}`;
const voiceNote = path.resolve('tests/fixtures/speech/mixed.wav');
let server;
let browser;

before(async () => {
  if (!live) {
    server = spawn('python', ['-m', 'http.server', String(port), '--directory', 'frontend'], { stdio: 'ignore' });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${baseUrl}/index.html`)).ok) break;
      } catch {
        // starting
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${voiceNote}`,
    ],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test('a spoken voice note (Arabic + English) is recorded, transcribed and lands in the composer', async () => {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const uploads = [];

  if (!live) {
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/features') return json({ voice_enabled: false, memory_enabled: true, changelog_enabled: false, dictation_server: true });
      if (url.pathname === '/api/transcribe') {
        const body = route.request().postDataBuffer();
        uploads.push({ bytes: body?.length ?? 0, type: route.request().headers()['content-type'] });
        return json({ text: 'Honestly, اليوم كان متعب. My manager غير الـ deadline and I feel stuck.', language: 'arabic' });
      }
      return json({});
    });
  } else {
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/transcribe') {
        uploads.push({ bytes: request.postDataBuffer()?.length ?? 0, type: request.headers()['content-type'] });
      }
    });
  }

  await page.goto(live ? `${baseUrl}/` : `${baseUrl}/index.html`);
  const composer = page.getByPlaceholder('Ask MindPal');
  await composer.waitFor({ state: 'visible' });
  if (live) {
    // A real backend may show "What's new" on first visit.
    await page.waitForTimeout(1_000);
    if (await page.locator('#changelog-modal').isVisible().catch(() => false)) await page.keyboard.press('Escape');
    await page.locator('#changelog-modal').waitFor({ state: 'hidden' }).catch(() => {});
  }
  await page.getByRole('button', { name: 'Dictate with your microphone' }).click();
  await page.getByRole('button', { name: 'Done dictating' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(6_500); // the fixture is ~6.6s of speech
  await page.getByRole('button', { name: 'Done dictating' }).click();

  await page.waitForFunction(() => /deadline/i.test(document.querySelector('textarea')?.value || ''), null, { timeout: 30_000 });
  const text = await composer.inputValue();
  if (live) console.log(`live transcript: ${text}`);
  assert.equal(uploads.length, 1, 'one upload per voice note');
  assert.match(uploads[0].type, /^audio\/(webm|mp4|ogg)/, 'the raw recording is the body');
  // The request event cannot read a Blob body; the mocked route can.
  if (!live) assert.ok(uploads[0].bytes > 5_000, `a real recording was sent (${uploads[0].bytes} bytes)`);
  assert.match(text, /[؀-ۿ]/, 'Arabic kept in Arabic script');
  assert.match(text, /\bI feel stuck\b|\bdeadline\b/i, 'English kept in English');
  await context.close();
});
