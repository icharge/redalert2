import { describe, expect, test } from "bun:test";
import { handleHttp } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig } from "../src/config";
import { makeTestStorage } from "./helpers";

function make() {
    const config = loadConfig({});
    const storage = makeTestStorage();
    const accounts = new AccountStore(storage, config);
    const sessions = new SessionManager(storage, config.sessionTtlSeconds);
    return { config, accounts, sessions };
}

describe("http routes", () => {
    test("GET /auth/session returns 401 when not logged in", async () => {
        const { config, accounts, sessions } = make();
        const res = await handleHttp(
            new Request("http://localhost/auth/session", { headers: { Origin: "http://localhost:5173" } }),
            accounts,
            sessions,
            config,
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
        expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    test("GET /auth/csrf returns a token", async () => {
        const { config, accounts, sessions } = make();
        const res = await handleHttp(new Request("http://localhost/auth/csrf"), accounts, sessions, config);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.csrfToken).toBeTruthy();
    });

    test("POST /auth/logout returns 204", async () => {
        const { config, accounts, sessions } = make();
        const res = await handleHttp(new Request("http://localhost/auth/logout", { method: "POST" }), accounts, sessions, config);
        expect(res.status).toBe(204);
    });

    test("register then login round-trips a session token", async () => {
        const { config, accounts, sessions } = make();
        const reg = await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            accounts,
            sessions,
            config,
        );
        expect(reg.status).toBe(200);
        const login = await handleHttp(
            new Request("http://localhost/login", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            accounts,
            sessions,
            config,
        );
        const data: any = await login.json();
        expect(data.sessionToken).toBeTruthy();
    });

    test("failed login returns 200 with an error body (client contract)", async () => {
        const { config, accounts, sessions } = make();
        await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            accounts,
            sessions,
            config,
        );
        const res = await handleHttp(
            new Request("http://localhost/login", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "wrongpass" }),
            }),
            accounts,
            sessions,
            config,
        );
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.error).toBeTruthy();
        expect(data.errorCode).toBe("invalid_credentials");
        expect(data.sessionToken).toBeUndefined();
    });

    test("duplicate register returns 200 with an error body", async () => {
        const { config, accounts, sessions } = make();
        await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            accounts,
            sessions,
            config,
        );
        const res = await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            accounts,
            sessions,
            config,
        );
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.error).toBeTruthy();
        expect(data.sessionToken).toBeUndefined();
    });

    test("OPTIONS preflight is answered with CORS headers", async () => {
        const { config, accounts, sessions } = make();
        const res = await handleHttp(
            new Request("http://localhost/login", {
                method: "OPTIONS",
                headers: { Origin: "http://localhost:5173" },
            }),
            accounts,
            sessions,
            config,
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
        expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
        expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-CSRF-Token");
    });
});
