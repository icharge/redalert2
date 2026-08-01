import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
const devPort = 4000;
// Plain HTTP by default. Drop a cert/key into ./certs to opt back into HTTPS
// (needed for the LAN QR camera scan when testing across real devices, since
// getUserMedia requires a secure context on non-localhost origins).
const manualHttpsConfig = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt')
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
export default defineConfig({
    plugins: [react()],
    server: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
        https: manualHttpsConfig,
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
        fs: {
            allow: ['..']
        }
    },
    preview: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
    },
    resolve: {
        alias: {
            '@': '/src'
        }
    },
    optimizeDeps: {
        exclude: ['7z-wasm', '@ffmpeg/ffmpeg'],
        include: []
    },
    worker: {
        format: 'es'
    },
    assetsInclude: ['**/*.wasm']
});
