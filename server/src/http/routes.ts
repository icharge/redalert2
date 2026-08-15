import { AccountStore } from "../auth/accountStore";
import { SessionManager } from "../auth/session";
import { ServerConfig } from "../config";
import { randomHex } from "../util/random";
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

export async function handleHttp(req: Request, accounts: AccountStore, sessions: SessionManager, config: ServerConfig): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(config, req) });
    }

    if (req.method === "POST" && url.pathname === "/login") {
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        const account = await accounts.verify(user, pass);
        if (!account) {
            return withCors(json({ error: "Invalid username or password", errorCode: "invalid_credentials" }), config, req);
        }
        if (account.banned) {
            return withCors(json({ error: "Account is banned", errorCode: "banned_from_server" }), config, req);
        }
        const sessionToken = sessions.create(account.username);
        return withCors(json({ user: account.username, sessionToken }), config, req);
    }

    if (req.method === "POST" && url.pathname === "/register") {
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        try {
            const account = await accounts.register(user, pass);
            const sessionToken = sessions.create(account.username);
            return withCors(json({ user: account.username, sessionToken }), config, req);
        }
        catch (error) {
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
        return withCors(new Response(null, { status: 204 }), config, req);
    }

    if (req.method === "GET" && url.pathname === "/health") {
        return withCors(json({ status: "ok", accounts: accounts.size(), sessions: sessions.size() }), config, req);
    }

    return withCors(new Response("Not Found", { status: 404 }), config, req);
}
