import React from 'react';
import { createRoot } from 'react-dom/client';
import { STORAGE_KEYS } from './constants/storage';
import { App } from './App';
import { getViewportMetrics } from './utils/mobile/viewport';

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

  // Keep the app anchored to the real viewport height while exposing the
  // keyboard gap for the composer dock to move independently on mobile.
  let layoutViewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  const setAppHeight = () => {
    const metrics = getViewportMetrics();
    const candidateHeight = Math.max(metrics.innerHeight, document.documentElement.clientHeight);
    if (metrics.visualHeight >= layoutViewportHeight - 80) {
      layoutViewportHeight = candidateHeight;
    }
    document.documentElement.style.setProperty('--app-height', `${Math.max(layoutViewportHeight, 0)}px`);
    document.documentElement.style.setProperty(
      '--keyboard-offset',
      `${Math.max(0, layoutViewportHeight - metrics.visualHeight)}px`,
    );
  };
  setAppHeight();
  window.addEventListener('resize', setAppHeight, { passive: true });
  window.visualViewport?.addEventListener('resize', setAppHeight, { passive: true });
  window.addEventListener('orientationchange', () => {
    window.setTimeout(() => {
      layoutViewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
      setAppHeight();
    }, 150);
  }, { passive: true });

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
