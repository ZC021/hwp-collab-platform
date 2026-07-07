import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // Vitest unit-test config. Additive to `npm run check` (node --check + CDP
  // smoke). The CDP smoke remains the integration gate for WASM-coupled
  // behavior; unit tests here cover pure logic (src/**/*.test.js).
  test: {
    environment: "jsdom",
    include: [
      "src/**/*.test.js",
      "src/**/*.test.jsx",
      "public/rhwp-studio/bridge/**/*.test.js"
    ],
    globals: false
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8170",
      "/ws": {
        target: "ws://127.0.0.1:8170",
        ws: true
      },
      "/relay": {
        target: "ws://127.0.0.1:8170",
        ws: true
      }
    }
  }
});
