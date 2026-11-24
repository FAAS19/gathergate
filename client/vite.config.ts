/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE || (process.env.VITE_DEMO === "1" ? "./" : "/"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: process.env.VITE_OUT_DIR || "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3080",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://127.0.0.1:3080",
        changeOrigin: true,
      },
    },
  },
});
