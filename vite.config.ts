import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      host: "localhost",
      proxy: {
        '/api/fal': {
          target: 'https://fal.run',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/fal/, ''),
          configure: (proxy, _options) => {
            proxy.on('proxyReq', (proxyReq, _req, _res) => {
              if (env.FAL_KEY) {
                proxyReq.setHeader('Authorization', `Key ${env.FAL_KEY}`);
              }
            });
          },
        },
      },
    },
  };
});
