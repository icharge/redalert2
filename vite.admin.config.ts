import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Admin console build. Uses the repo's existing react/vite deps; the game
// build (vite.config.ts) is untouched. Dev server proxies the API to the
// local Bun server (server/.env SERVER_PORT, default 9090).
export default defineConfig({
    root: "admin",
    plugins: [react()],
    build: {
        outDir: "../dist-admin",
        emptyOutDir: true,
    },
    server: {
        port: 5174,
        proxy: {
            "/login": { target: "http://127.0.0.1:9090", changeOrigin: true },
            "/admin": { target: "http://127.0.0.1:9090", changeOrigin: true },
        },
    },
});
