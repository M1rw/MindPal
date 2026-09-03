// scripts/audit/benchmark_frontend.mjs

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Simple static server for frontend/ directory
function createServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(process.cwd(), 'frontend', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      if (fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

function auditStaticAssets() {
  console.log('\n--- Running Static Asset & Dead Code Analysis ---');
  const indexHtml = fs.readFileSync('frontend/index.html', 'utf-8');
  const cssStyle = fs.readFileSync('frontend/css/style.css', 'utf-8');

  const findings = [];

  // Check for orphan CSS / unused classes
  if (indexHtml.includes('node-list')) {
    findings.push('Found legacy node-list memory markup in index.html');
  }
  if (cssStyle.includes('.legacy-brain-card')) {
    findings.push('Found orphaned .legacy-brain-card styles in style.css');
  }

  const indexSizeBytes = fs.statSync('frontend/index.html').size;
  const appBundleSizeBytes = fs.existsSync('frontend/dist/app.bundle.js') ? fs.statSync('frontend/dist/app.bundle.js').size : 0;
  const styleCssSizeBytes = fs.statSync('frontend/css/style.css').size;

  console.log(`- index.html: ${(indexSizeBytes / 1024).toFixed(1)} KB`);
  console.log(`- dist/app.bundle.js: ${(appBundleSizeBytes / 1024).toFixed(1)} KB`);
  console.log(`- css/style.css: ${(styleCssSizeBytes / 1024).toFixed(1)} KB`);
  console.log(`- Static Findings: ${findings.length > 0 ? findings.join(', ') : 'None'}`);

  return {
    indexSizeBytes,
    appBundleSizeBytes,
    styleCssSizeBytes,
    findings,
  };
}

async function runBenchmark() {
  const staticAudit = auditStaticAssets();

  const PORT = 8089;
  const server = await createServer(PORT);
  console.log(`Static server running on http://localhost:${PORT}`);

  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { name: 'Desktop', width: 1280, height: 800 },
    { name: 'Mobile', width: 390, height: 844 },
  ];

  const auditResults = {
    staticAudit,
  };

  for (const vp of viewports) {
    console.log(`\n--- Running Interactive Session Benchmark on ${vp.name} (${vp.width}x${vp.height}) ---`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const networkLogs = [];
    page.on('request', (req) => {
      networkLogs.push({
        url: req.url(),
        method: req.method(),
        timestampMs: Date.now(),
      });
    });

    page.on('response', async (res) => {
      const match = networkLogs.find((l) => l.url === res.url());
      if (match) {
        match.status = res.status();
        try {
          const buffer = await res.body();
          match.sizeBytes = buffer.length;
        } catch (e) {
          match.sizeBytes = 0;
        }
      }
    });

    // 1. Open App
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // 2. Inject 200 synthetic messages into chat DOM
    const injectMetrics = await page.evaluate(() => {
      const chatContainer = document.querySelector('#chat-history') || document.querySelector('#chat-messages') || document.body;
      const startTime = performance.now();

      for (let i = 0; i < 200; i++) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${i % 2 === 0 ? 'user-message' : 'assistant-message'}`;
        msgDiv.innerHTML = `<div class="message-content"><p>This is synthetic test message #${i + 1} for 200+ message DOM scaling and rendering audit.</p></div>`;
        chatContainer.appendChild(msgDiv);
      }

      const endTime = performance.now();
      const totalDomNodes = document.getElementsByTagName('*').length;
      const chatDomNodes = chatContainer.getElementsByTagName('*').length;

      return {
        injectionTimeMs: endTime - startTime,
        totalDomNodes,
        chatDomNodes,
      };
    });

    // 3. Interactive UI Actions (Open Settings, Open Memory Modal, Open Analytics if triggers present)
    await page.evaluate(() => {
      const settingsBtn = document.querySelector('[data-action="open-settings"]') || document.querySelector('#settings-btn');
      if (settingsBtn) settingsBtn.click();
    });
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const memoryBtn = document.querySelector('[data-action="open-memory"]') || document.querySelector('#memory-btn');
      if (memoryBtn) memoryBtn.click();
    });
    await page.waitForTimeout(300);

    // Measure Memory & JS Heap
    const performanceMetrics = await page.evaluate(() => {
      const perfMemory = window.performance.memory ? {
        usedJSHeapSize: window.performance.memory.usedJSHeapSize,
        totalJSHeapSize: window.performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: window.performance.memory.jsHeapSizeLimit,
      } : null;
      return { perfMemory };
    });

    // Simulate Scroll Performance
    const scrollMetrics = await page.evaluate(async () => {
      const chatContainer = document.querySelector('#chat-history') || document.documentElement;
      const startScroll = performance.now();
      for (let i = 0; i < 10; i++) {
        chatContainer.scrollTop = i * 500;
        await new Promise((r) => setTimeout(r, 20));
      }
      const endScroll = performance.now();
      return { scrollDurationMs: endScroll - startScroll };
    });

    auditResults[vp.name] = {
      viewport: vp,
      domMetrics: injectMetrics,
      performance: performanceMetrics,
      scrollMetrics,
      networkRequestsCount: networkLogs.length,
      networkRequests: networkLogs,
    };

    await context.close();
  }

  await browser.close();
  server.close();

  fs.writeFileSync('data/audit_fixtures/frontend_benchmark_results.json', JSON.stringify(auditResults, null, 2));
  console.log('\nFrontend Benchmark Completed! Results written to data/audit_fixtures/frontend_benchmark_results.json');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
