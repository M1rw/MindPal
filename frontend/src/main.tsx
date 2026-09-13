import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// ── Production Bootstrap: Viewport, PWA & Analytics ──────────────────────────
(() => {
  // Analytics Queues (Vercel Web Analytics & Speed Insights)
  const win = window as any;
  win.va = win.va || function () { (win.vaq = win.vaq || []).push(arguments); };
  win.si = win.si || function () { (win.siq = win.siq || []).push(arguments); };

  // iOS Safari / Mobile Dynamic Viewport Fix
  const setAppHeight = () => {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
  };
  setAppHeight();
  window.addEventListener('resize', setAppHeight, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 150), { passive: true });

  // PWA Standalone Mode Indicator
  const isStandalone =
    (navigator as any).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  document.body.classList.toggle('standalone', isStandalone);

  // Theme Initialization
  try {
    const savedTheme = localStorage.getItem('mindpal_theme');
    if (savedTheme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  } catch {
    document.documentElement.classList.add('dark');
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
