import { AccountStore } from "../auth/accountStore";
import { SessionManager } from "../auth/session";
import { ServerConfig } from "../config";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

function httpUrlOf(config: ServerConfig): string {
    return config.externalUrl.replace(/^wss?/, "http");
}

export async function handleHttp(req: Request, accounts: AccountStore, sessions: SessionManager, config: ServerConfig): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method === "POST" && url.pathname === "/login") {
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            return json({ error: "Invalid request body", errorCode: "invalid_request" }, 400);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        const account = await accounts.verify(user, pass);
        if (!account) {
            return json({ error: "Invalid username or password", errorCode: "invalid_credentials" }, 401);
        }
        if (account.banned) {
            return json({ error: "Account is banned", errorCode: "banned_from_server" }, 403);
        }
        const sessionToken = sessions.create(account.username);
        return json({ user: account.username, sessionToken });
    }

    if (req.method === "POST" && url.pathname === "/register") {
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            return json({ error: "Invalid request body", errorCode: "invalid_request" }, 400);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        try {
            const account = await accounts.register(user, pass);
            const sessionToken = sessions.create(account.username);
            return json({ user: account.username, sessionToken });
        }
        catch (error) {
            return json({ error: String((error as Error).message), errorCode: "registration_failed" }, 400);
        }
    }

    if (req.method === "GET" && url.pathname === "/servers.ini") {
        const baseUrl = httpUrlOf(config);
        const wsUrl = config.externalUrl;
        const ini = `[local]
label="Local Dev"
available=yes
gameVersion=${config.gameVersion}
wolUrl="${wsUrl}"
apiLoginUrl="${baseUrl}/login"
apiRegUrl="${baseUrl}/register"
`;
        return new Response(ini, {
            headers: {
                "Content-Type": "text/plain",
                ...CORS_HEADERS,
            },
        });
    }

    if (req.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", accounts: accounts.size(), sessions: sessions.size() });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
}
