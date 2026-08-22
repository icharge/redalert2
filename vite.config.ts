import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
// Plain HTTP by default. scripts/dev-all.mjs auto-generates a cert into
// ./certs when it's needed: cross-PC LAN testing (OPFS/Cache-API game-asset
// storage and getUserMedia for the LAN QR scan both require a secure context
// on anything other than localhost — plain HTTP only gets that exemption on
// loopback). The backend (server/src/index.ts) picks up the exact same cert
// files independently, so both sides always agree on HTTP vs HTTPS.
const hasTls = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt');
const manualHttpsConfig = hasTls
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
// Lets the client reach the backend's plain HTTP endpoints (login, register,
// servers.ini, auth, ...) through this dev server's own origin instead of
// the backend's own host:9090 directly — same-origin, so no CORS/mixed-
// content/secure-context concerns, and works identically whether the
// browser making the request is on this machine or another PC on the LAN
// (proxying is server-to-server; the target is always this same machine's
// loopback).
//
// Deliberately does NOT include /wol or /gserv (the actual game
// WebSockets): once server.https is set, Vite always creates a node:http2
// server with allowHTTP1: true (see resolveHttpServer in vite's own
// source), and Node's http2 module offers h2 in ALPN unconditionally in
// that mode — passing ALPNProtocols: ['http/1.1'] does not override it,
// confirmed directly against node:http2 with vite out of the picture
// entirely. Once a connection negotiates h2, the classic 'upgrade' event
// this proxy's ws:true relies on never fires (WebSocket-over-h2 is RFC 8441
// Extended CONNECT, a different mechanism this proxy doesn't implement),
// and the request just falls through to a 404. There's no config-level fix
// for this in Vite as of 8.0.1 — so the game WebSocket connects directly to
// the backend's own port instead (server/src/http/routes.ts's /servers.ini
// response advertises that directly; Bun.serve()'s own TLS/upgrade handling
// has no such issue). That does mean the backend's origin needs its own
// one-time browser cert-trust click-through, separate from this one.
//   secure: false — the target is our own just-generated self-signed cert;
// without this Node's proxy client would refuse it as untrusted.
//   xfwd: true — adds X-Forwarded-Host/-Proto/-For for the original request
// (the ones changeOrigin overwrites on Host). /servers.ini's handler reads
// these to advertise whichever origin the browser is actually connected
// through — localhost, 127.0.0.1, and a LAN IP can all reach this same dev
// server, and only one of them can ever be "the" externalUrl set at server
// startup.
const backendProxyTarget = `${hasTls ? 'https' : 'http'}://127.0.0.1:9090`;
const backendProxy = Object.fromEntries([
    '/login', '/register', '/servers.ini', '/admin',
    '/replays', '/ladder', '/wgameres', '/errorreport', '/auth', '/health',
].map((path) => [path, {
    target: backendProxyTarget,
    changeOrigin: true,
    secure: false,
    xfwd: true,
}]));
export default defineConfig(({ mode }) => ({
    plugins: [react()],
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
        https: manualHttpsConfig,
        proxy: backendProxy,
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
