import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import { execSync } from 'child_process';
const devPort = 4000;
function getGitShortHash(): string {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }
    catch {
        return 'dev';
    }
}
const manualHttpsConfig = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt')
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
export default defineConfig(({ mode }) => ({
    plugins: [react(), ...(manualHttpsConfig ? [] : [basicSsl()])],
    define: {
        __GIT_HASH__: JSON.stringify(getGitShortHash()),
    },
    build: {
        chunkSizeWarningLimit: 4096,
        minify: mode === 'single' ? 'oxc' : false,
        rolldownOptions: {
            output: {
                inlineDynamicImports: mode === 'single',
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
}));
