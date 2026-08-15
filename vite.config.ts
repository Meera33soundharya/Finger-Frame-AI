import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const FAL_KEY = env.FAL_KEY ?? "";

    return {
        plugins: [react()],
        server: {
            host: "localhost",
            port: 5173,
            strictPort: true,
            proxy: {
                // ── Fal.ai image-to-image proxy ──────────────────────────────
                // Forwards /api/fal/<model-path> → https://fal.run/<model-path>
                // Injects the API key server-side so it is never exposed to the browser.
                "/api/fal": {
                    target: "https://fal.run",
                    changeOrigin: true,
                    secure: true,
                    rewrite: (path: string) => path.replace(/^\/api\/fal/, ""),
                    configure: (proxy: import("http-proxy").Server) => {
                        proxy.on("proxyReq", (proxyReq: import("http").ClientRequest) => {
                            if (FAL_KEY) {
                                proxyReq.setHeader("Authorization", `Key ${FAL_KEY}`);
                            }
                        });
                    },
                },
            },
        },
    };
});

