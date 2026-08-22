import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeOnly = process.env.VOICE_RUNTIME_ONLY === "1" || process.env.VOICE_V3_RUNTIME_ONLY === "1";

export default defineConfig({
  base: "/voice/",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
    emptyOutDir: !runtimeOnly,
    rollupOptions: {
      input: runtimeOnly
        ? { runtime: resolve("src/production-entry.ts") }
        : {
            review: resolve("index.html"),
            runtime: resolve("src/production-entry.ts"),
          },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2022",
    },
  },
});
