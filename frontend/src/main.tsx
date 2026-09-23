import React from 'react';
import { createRoot } from 'react-dom/client';
import { STORAGE_KEYS } from './constants/storage';
import { App } from './App';
import { applyViewportHeight } from './utils/mobile/viewport';

// ── Production Bootstrap: Viewport, PWA & Analytics ──────────────────────────
(() => {
  type MindPalWindow = Window & {
    va?: (...args: unknown[]) => void;
    vaq?: unknown[];
    si?: (...args: unknown[]) => void;
    siq?: unknown[];
  };

  // Analytics Queues (Vercel Web Analytics & Speed Insights)
  const win = window as MindPalWindow;
  win.va = win.va || function () { (win.vaq = win.vaq || []).push(arguments); };
  win.si = win.si || function () { (win.siq = win.siq || []).push(arguments); };
  // Load the Vercel scripts only on Vercel deployments. This used to be an inline
  // <script> in index.html, which kept 'unsafe-inline' necessary in the CSP.
  if (window.location.hostname.endsWith('.vercel.app')) {
    for (const src of ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js']) {
      const script = document.createElement('script');
      script.defer = true;
      script.src = src;
      document.head.appendChild(script);
    }
  }

  // iOS Safari / Mobile Dynamic Viewport Fix with visualViewport support
  const setAppHeight = () => {
    applyViewportHeight(window);
  };
  setAppHeight();
  window.addEventListener('resize', setAppHeight, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 150), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight, { passive: true });
    window.visualViewport.addEventListener('scroll', setAppHeight, { passive: true });
  }

  // PWA Standalone Mode Indicator
  const isStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  document.body.classList.toggle('standalone', isStandalone);

  // Theme Initialization
  try {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME);
    if (savedTheme === 'light') {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    }
  } catch {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  }
})();

// ── Mount React 19 Root ───────────────────────────────────────────────────────
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
