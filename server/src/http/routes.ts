import { AccountStore } from "../auth/accountStore";
import { SessionManager } from "../auth/session";
import { ServerConfig } from "../config";
import { Logger, makeLogger } from "../logger";
import { randomHex } from "../util/random";
import { FixedWindowLimiter } from "../util/rateLimit";
import { corsHeaders, withCors } from "./cors";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function httpUrlOf(config: ServerConfig): string {
    return config.externalUrl.replace(/^wss/, "https").replace(/^ws/, "http");
}

function remoteOf(req: Request): string {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("cf-connecting-ip") ?? "-";
}

// Limiters are stateful, so keep one pair per config object (config is fixed
// per process; tests pass their own config objects and get fresh limiters).
const limitersByConfig = new WeakMap<ServerConfig, { login: FixedWindowLimiter; register: FixedWindowLimiter }>();

function limitersFor(config: ServerConfig): { login: FixedWindowLimiter; register: FixedWindowLimiter } {
    let entry = limitersByConfig.get(config);
    if (!entry) {
        entry = {
            login: new FixedWindowLimiter(config.loginMaxPerMin, 60_000),
            register: new FixedWindowLimiter(config.registerMaxPerHour, 3_600_000),
        };
        limitersByConfig.set(config, entry);
    }
    return entry;
}

// Drop cached rate-limit windows so a config reload takes effect immediately.
export function resetRateLimiters(config: ServerConfig): void {
    limitersByConfig.delete(config);
}

export async function handleHttp(req: Request, accounts: AccountStore, sessions: SessionManager, config: ServerConfig, log: Logger = makeLogger("error", "http")): Promise<Response> {
    const url = new URL(req.url);
    const ip = remoteOf(req);
    log.debug(`http ${req.method} ${url.pathname} from ${ip}`);

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(config, req) });
    }

    if (req.method === "POST" && url.pathname === "/login") {
        if (!limitersFor(config).login.allow(ip)) {
            log.warn(`login rate limited for ${ip}`);
            return withCors(json({ error: "Too many attempts, try again later", errorCode: "rate_limited" }, 429), config, req);
        }
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            log.warn(`login: invalid request body from ${ip}`);
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        const account = await accounts.verify(user, pass);
        if (!account) {
            log.warn(`login failed for "${user}" from ${ip} (invalid credentials)`);
            return withCors(json({ error: "Invalid username or password", errorCode: "invalid_credentials" }), config, req);
        }
        if (account.banned) {
            log.warn(`login blocked for banned account "${user}" from ${ip}`);
            return withCors(json({ error: "Account is banned", errorCode: "banned_from_server" }), config, req);
        }
        const sessionToken = sessions.create(account.username);
        log.info(`login ok "${account.username}" from ${ip}`);
        return withCors(json({ user: account.username, sessionToken }), config, req);
    }

    if (req.method === "POST" && url.pathname === "/register") {
        if (!limitersFor(config).register.allow(ip)) {
            log.warn(`register rate limited for ${ip}`);
            return withCors(json({ error: "Too many accounts, try again later", errorCode: "rate_limited" }, 429), config, req);
        }
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            log.warn(`register: invalid request body from ${ip}`);
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        try {
            const account = await accounts.register(user, pass);
            const sessionToken = sessions.create(account.username);
            log.info(`register ok "${account.username}" from ${ip}`);
            return withCors(json({ user: account.username, sessionToken }), config, req);
        }
        catch (error) {
            log.warn(`register failed for "${user}" from ${ip}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message), errorCode: "registration_failed" }), config, req);
        }
    }

    if (req.method === "GET" && url.pathname === "/servers.ini") {
        const baseUrl = httpUrlOf(config);
        const wsUrl = config.externalUrl + config.wolUrlPath;
        const ini = `[local]
label="Local Dev"
available=yes
gameVersion=${config.gameVersion}
wolUrl="${wsUrl}"
apiLoginUrl="${baseUrl}/login"
apiRegUrl="${baseUrl}/register"
`;
        return withCors(new Response(ini, { headers: { "Content-Type": "text/plain" } }), config, req);
    }

    if (req.method === "GET" && url.pathname === "/auth/session") {
        return withCors(json({ error: "no session" }, 401), config, req);
    }

    if (req.method === "GET" && url.pathname === "/auth/csrf") {
        return withCors(json({ csrfToken: randomHex(16) }), config, req);
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
        try {
            const body: any = await req.json();
            if (typeof body?.sessionToken === "string" && body.sessionToken) {
                sessions.revoke(body.sessionToken);
                log.info(`session revoked via logout for ${ip}`);
            }
        }
        catch {
            // Empty body (upstream realm flow posts with no payload) is fine.
        }
        return withCors(new Response(null, { status: 204 }), config, req);
    }

    if (req.method === "GET" && url.pathname === "/health") {
        return withCors(json({ status: "ok", accounts: accounts.size(), sessions: sessions.size() }), config, req);
    }

    return withCors(new Response("Not Found", { status: 404 }), config, req);
}
