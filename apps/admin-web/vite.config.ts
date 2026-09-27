import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // `ws: true` (WT-16): the FleetPresence WebSocket feed (`/api/v1/realtime/fleet`) is under
    // `/api` too, and Vite's dev proxy does not upgrade WebSocket connections by default.
    proxy: { "/api": { target: "http://localhost:8787", ws: true } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
