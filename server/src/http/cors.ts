import { ServerConfig } from "../config";

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS = "Content-Type, X-CSRF-Token";

export function isOriginAllowed(config: ServerConfig, request: Request): boolean {
    const allowed = config.corsAllowedOrigins;
    if (allowed.length === 1 && allowed[0] === "*") {
        return true;
    }
    const origin = request.headers.get("Origin");
    return origin !== null && allowed.includes(origin);
}

export function corsHeaders(config: ServerConfig, request: Request): Record<string, string> {
    const allowed = config.corsAllowedOrigins;
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": CORS_METHODS,
        "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
        "Vary": "Origin",
    };
    if (allowed.length === 1 && allowed[0] === "*") {
        headers["Access-Control-Allow-Origin"] = "*";
        return headers;
    }
    const origin = request.headers.get("Origin");
    if (origin && allowed.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
}

export function withCors(response: Response, config: ServerConfig, request: Request): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(config, request))) {
        headers.set(name, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
