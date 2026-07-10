// Pre-app bootstrap: analytics queues, viewport fixes, and loader fail-safe.
(() => {
  window.va = window.va || function mindPalAnalyticsQueue() {
    (window.vaq = window.vaq || []).push(arguments);
  };
  window.si = window.si || function mindPalSpeedInsightsQueue() {
    (window.siq = window.siq || []).push(arguments);
  };

  const setAppHeight = () => {
    document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
  };

  const removeLoader = () => {
    const loader = document.getElementById("global-loader");
    if (!loader) return;
    loader.style.opacity = "0";
    window.setTimeout(() => loader.remove(), 700);
  };

  const startLoaderTyper = () => {
    const element = document.getElementById("loader-typer");
    if (!element) return;

    const phrases = ["Hello.", "Getting things ready…", "Almost there…"];
    let phraseIndex = 0;
    let characterIndex = 0;

    const type = () => {
      if (!element.isConnected) return;
      const phrase = phrases[phraseIndex];
      if (characterIndex <= phrase.length) {
        element.textContent = phrase.slice(0, characterIndex);
        characterIndex += 1;
        window.setTimeout(type, 70);
        return;
      }

      window.setTimeout(() => {
        if (phraseIndex >= phrases.length - 1 || !element.isConnected) return;
        element.style.opacity = "0";
        window.setTimeout(() => {
          phraseIndex += 1;
          characterIndex = 0;
          element.textContent = "";
          element.style.opacity = "1";
          window.setTimeout(type, 100);
        }, 400);
      }, 1800);
    };

    window.setTimeout(type, 300);
  };

  const initialize = () => {
    setAppHeight();
    window.addEventListener("resize", setAppHeight, { passive: true });
    window.addEventListener("orientationchange", () => window.setTimeout(setAppHeight, 150), { passive: true });

    const standalone = window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    document.body.classList.toggle("standalone", standalone);

    startLoaderTyper();

    window.__mindpalLoaderTimer = window.setTimeout(() => {
      console.warn("[MindPal] App bootstrap exceeded the safety timeout.");
      removeLoader();
    }, 12_000);
  };

  window.addEventListener("error", (event) => {
    const source = String(event.filename || "");
    if (source.includes("/dist/app.bundle.js")) removeLoader();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
