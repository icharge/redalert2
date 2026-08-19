#!/usr/bin/env bun
// Starts the client (vite) and backend (server/) dev servers together with
// one command. The browser talks to vite's own origin (http(s)://<host>:4000)
// for the page and every plain-HTTP endpoint — login, register, servers.ini,
// auth, etc. — which vite proxies to the backend over loopback
// (vite.config.ts), regardless of whether the browser making the request is
// on this machine or another PC on the LAN.
//
// The actual game WebSocket (wolUrl in /servers.ini's response) is the one
// thing that does NOT go through that proxy — it connects straight to the
// backend's own port. This isn't a choice, it's forced: once Vite's dev
// server has HTTPS configured it always negotiates HTTP/2 via ALPN, and
// Node's http2 module offers h2 unconditionally in that mode with no
// config-level way to stop it, which breaks the classic HTTP/1.1 Upgrade
// mechanism a WebSocket proxy needs (see vite.config.ts's backendProxy
// comment for the full story — this took an isolated repro against
// node:http2 directly, bypassing Vite, to confirm). So the backend's own
// origin needs its own one-time browser cert-trust click-through too,
// separate from the client's — two origins, not the one this script
// originally aimed for.
//
// public/config.ini's serversUrl and [Gateway] baseUrl are plain relative
// URLs (see the comments there) and resolve against whatever origin the
// browser is actually on — localhost, 127.0.0.1, or a LAN IP all work from
// the same build, with no per-run patching needed. The backend's
// /servers.ini response is similarly host-aware for both the proxied HTTP
// endpoints and the direct WebSocket one: it reads X-Forwarded-Host (set by
// vite's proxy, xfwd: true) to advertise URLs against whichever origin the
// request actually came in on, not a value fixed at server startup — same
// reasoning for isOriginAllowed()'s default-open CORS policy (see
// server/src/http/cors.ts), so this script doesn't override
// CORS_ALLOWED_ORIGINS either.
//
// What this script still does:
//   - EXTERNAL_URL (spawn-time env override) — the *fallback* the backend
//     uses when a request has no X-Forwarded-Host (i.e. reached directly),
//     and what a freshly-created gserv match instance advertises its own
//     URL as. Points at the backend's own port (SERVER_PORT), matching how
//     the WebSocket always connects.
//   - ./certs/server.{key,crt} — auto-generated self-signed cert (via
//     openssl) covering localhost + the current host, shared by vite
//     (vite.config.ts) and the backend (server/src/index.ts). Skipped
//     entirely when host is loopback (127.0.0.1/localhost), since that
//     already gets a secure-context exemption without needing HTTPS at all
//     — a cert's SAN list is the one thing here that genuinely can't be
//     made host-agnostic, TLS requires it to name every address in use.
//
// Usage:
//   bun run dev:all                     # host = auto-detected LAN IP
//   bun run dev:all -- --host 127.0.0.1 # force localhost-only, no TLS at all
//   DEV_HOST=192.168.1.50 bun run dev:all
import { spawn, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certsDir = path.join(rootDir, 'certs');
const keyPath = path.join(certsDir, 'server.key');
const certPath = path.join(certsDir, 'server.crt');
const CLIENT_PORT = 4000;
const SERVER_PORT = 9090; // must match vite.config.ts's backendProxyTarget

function parseHostArg() {
    const argIndex = process.argv.indexOf('--host');
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        return process.argv[argIndex + 1];
    }
    return process.env.DEV_HOST;
}

function detectLanIp() {
    for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Generates (or regenerates, if `host` isn't already covered) a self-signed
// cert with a SAN list of localhost/127.0.0.1/::1 + host, so Chrome accepts
// it for whichever address the browser is actually pointed at. Returns
// false (falls back to plain HTTP/WS) if openssl isn't available, rather
// than hard-failing dev entirely.
function ensureCert(host) {
    const sanEntries = new Set(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
    sanEntries.add(IPV4_RE.test(host) ? `IP:${host}` : `DNS:${host}`);
    const sanString = [...sanEntries].join(',');

    if (existsSync(keyPath) && existsSync(certPath)) {
        try {
            const text = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], { encoding: 'utf8' });
            if (text.includes(host)) {
                return true;
            }
            console.log(`[dev-all] existing certs/server.crt doesn't cover ${host}; regenerating`);
        }
        catch {
            console.log('[dev-all] could not inspect existing cert (openssl missing?); regenerating');
        }
    }

    mkdirSync(certsDir, { recursive: true });
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', keyPath, '-out', certPath, '-days', '825',
            '-subj', '/CN=ra2web-dev',
            '-addext', `subjectAltName=${sanString}`,
        ], { stdio: 'pipe' });
        console.log(`[dev-all] generated self-signed cert (certs/server.{key,crt}) for ${sanString}`);
        return true;
    }
    catch (e) {
        console.warn('[dev-all] openssl not available; falling back to plain HTTP/WS.');
        console.warn('[dev-all] game-asset import needs a secure context and will fail on non-localhost hosts without a cert.');
        return false;
    }
}

function spawnLabeled(label, command, args, env) {
    const child = spawn(command, args, {
        cwd: rootDir,
        env: { ...process.env, ...env },
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    const prefix = `[${label}] `;
    const pipe = (stream, out) => {
        let buffered = '';
        stream.on('data', (chunk) => {
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
                out.write(prefix + line + '\n');
            }
        });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    return child;
}

const host = parseHostArg() ?? detectLanIp();
const isLoopback = host === '127.0.0.1' || host === 'localhost';
// Loopback doesn't need a cert generated, but vite and the backend both
// decide TLS purely by whether certs/server.{key,crt} exist on disk (not by
// host) — so if a cert is already there from an earlier cross-PC run, both
// of them will use it regardless of what's requested here. Must mirror that
// exact check, or dev-all.mjs's belief about the scheme drifts from what's
// actually served.
const hasTls = isLoopback ? (existsSync(keyPath) && existsSync(certPath)) : ensureCert(host);
const httpScheme = hasTls ? 'https' : 'http';
const wsScheme = hasTls ? 'wss' : 'ws';
const clientOrigin = `${httpScheme}://${host}:${CLIENT_PORT}`;

const server = spawnLabeled('server', 'bun', ['run', '--cwd', 'server', 'dev'], {
    SERVER_HOST: '0.0.0.0',
    EXTERNAL_URL: `${wsScheme}://${host}:${SERVER_PORT}`,
});
const client = spawnLabeled('client', 'bun', ['--bun', 'vite']);

let shuttingDown = false;
function shutdown(code) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    server.kill('SIGTERM');
    client.kill('SIGTERM');
    process.exitCode = code;
}

server.on('exit', (code) => {
    console.error(`[dev-all] server exited (${code}); stopping client too`);
    shutdown(code ?? 1);
});
client.on('exit', (code) => {
    console.error(`[dev-all] client exited (${code}); stopping server too`);
    shutdown(code ?? 1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[dev-all] open ${clientOrigin} (or localhost/127.0.0.1/any address this machine answers to on :${CLIENT_PORT})`);
console.log(`[dev-all] pick "Local Dev" in the region list once the client loads.`);
if (hasTls) {
    console.log(`[dev-all] self-signed cert: accept the browser warning for BOTH ${clientOrigin} and ${httpScheme}://${host}:${SERVER_PORT} — the game WebSocket connects to the backend's port directly (see this file's header comment for why), so it needs its own click-through too.`);
}
console.log('[dev-all] Ctrl+C stops both.');
