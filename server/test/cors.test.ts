import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { corsHeaders, isOriginAllowed, withCors } from "../src/http/cors";

function request(origin?: string): Request {
    const headers: Record<string, string> = {};
    if (origin) {
        headers["Origin"] = origin;
    }
    return new Request("http://localhost/health", { headers });
}

describe("cors", () => {
    test("default echoes the request origin with credentials", () => {
        const config = loadConfig({});
        const headers = corsHeaders(config, request("http://localhost:5173"));
        expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
        expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
        expect(headers["Access-Control-Allow-Headers"]).toContain("X-CSRF-Token");
        expect(headers["Vary"]).toBe("Origin");
        expect(isOriginAllowed(config, request("http://localhost:5173"))).toBe(true);
    });

    test("default sends no allow-origin when no Origin header is present", () => {
        const config = loadConfig({});
        const headers = corsHeaders(config, request());
        expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    test("restricted origins echo the matching origin with credentials", () => {
        const config = loadConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://game.example.com" });
        const headers = corsHeaders(config, request("http://localhost:5173"));
        expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
        expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });

    test("restricted origins reject unknown origins", () => {
        const config = loadConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" });
        const headers = corsHeaders(config, request("https://evil.example.com"));
        expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
        expect(isOriginAllowed(config, request("https://evil.example.com"))).toBe(false);
    });

    test("withCors attaches headers to a response", () => {
        const config = loadConfig({});
        const response = withCors(new Response("x", { status: 200 }), config, request("http://localhost:5173"));
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
        expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });
});
