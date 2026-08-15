import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
const devPort = 4000;
const manualHttpsConfig = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt')
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
export default defineConfig({
    plugins: [react(), ...(manualHttpsConfig ? [] : [basicSsl()])],
    build: {
        chunkSizeWarningLimit: 2048,
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)/, priority: 3 },
                        { name: 'three', test: /node_modules[\\/](three|three\.meshline)/, priority: 3 },
                        { name: 'vendor', test: /node_modules/, priority: 2 },
                        { name: 'engine', test: /src[\\/]engine/, priority: 2 },
                        { name: 'game', test: /src[\\/]game/, priority: 2 },
                        { name: 'network', test: /src[\\/]network/, priority: 2 },
                        { name: 'data', test: /src[\\/]data/, priority: 2 },
                        { name: 'menu', test: /src[\\/]gui[\\/]screen[\\/]mainMenu/, priority: 2 },
                        { name: 'gameui', test: /src[\\/]gui[\\/]screen[\\/]game/, priority: 2 },
                        { name: 'gui', test: /src[\\/]gui/, priority: 1 },
                        { name: 'util', test: /src[\\/]util/, priority: 1 },
                        { name: 'types', test: /src[\\/]types/, priority: 1 },
                        { name: 'tools', test: /src[\\/]tools/, priority: 1 },
                    ],
                },
            },
        },
    },
    server: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
        https: manualHttpsConfig ?? {},
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
