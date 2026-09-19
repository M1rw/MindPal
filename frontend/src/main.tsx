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

  // Position the composer against the visual viewport. iOS keeps the layout
  // viewport stable while the keyboard changes the visual viewport.
  let layoutViewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  const setAppHeight = () => {
    const metrics = getViewportMetrics();
    const viewport = window.visualViewport;
    const candidateHeight = Math.max(metrics.innerHeight, document.documentElement.clientHeight);
    if (!viewport || metrics.visualHeight >= layoutViewportHeight - 80) {
      layoutViewportHeight = candidateHeight;
    }
    const offsetTop = viewport?.offsetTop ?? 0;
    const visualViewportBottomInset = Math.max(
      0,
      layoutViewportHeight - metrics.visualHeight - offsetTop,
    );
    const keyboardOpen = metrics.keyboardOffset > 0;
    const visibleAppHeight = keyboardOpen ? metrics.visualHeight : layoutViewportHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.max(visibleAppHeight, 0)}px`);
    document.documentElement.style.setProperty('--keyboard-offset', `${visualViewportBottomInset}px`);
    document.documentElement.style.setProperty(
      '--visual-viewport-bottom-inset',
      `${visualViewportBottomInset}px`,
    );
    document.body.classList.toggle('keyboard-open', keyboardOpen);
    if (keyboardOpen) window.scrollTo(0, 0);
  };
  setAppHeight();
  window.addEventListener('resize', setAppHeight, { passive: true });
  window.visualViewport?.addEventListener('resize', setAppHeight, { passive: true });
  window.visualViewport?.addEventListener('scroll', setAppHeight, { passive: true });
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
