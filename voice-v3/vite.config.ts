import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/voice-v3/",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
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
