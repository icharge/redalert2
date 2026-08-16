import { describe, expect, test } from "bun:test";
import { handleHttp, HttpDeps } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig } from "../src/config";
import { makeTestStorage } from "./helpers";
import { LadderService } from "../src/ladder/LadderService";
import { GservManager } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";

function make() {
    const config = loadConfig({});
    const storage = makeTestStorage();
    const accounts = new AccountStore(storage, config);
    const sessions = new SessionManager(storage, config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wol = new WolServer(config, sessions, accounts, gservs);
    const ladder = new LadderService(storage, makeTestLogger(), {
        startingRating: config.startingRating,
        placementMatches: config.placementMatches,
    });
    const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol };
    return { config, accounts, sessions, deps };
}

function makeTestLogger() {
    return {
        level: "error" as const,
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as any;
}

describe("http routes", () => {
    test("GET /auth/session returns 401 when not logged in", async () => {
        const { config, deps } = make();
        const res = await handleHttp(
            new Request("http://localhost/auth/session", { headers: { Origin: "http://localhost:5173" } }),
            deps,
            config,
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
        expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    test("GET /auth/csrf returns a token", async () => {
        const { config, deps } = make();
        const res = await handleHttp(new Request("http://localhost/auth/csrf"), deps, config);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.csrfToken).toBeTruthy();
    });

    test("POST /auth/logout returns 204", async () => {
        const { config, deps } = make();
        const res = await handleHttp(new Request("http://localhost/auth/logout", { method: "POST" }), deps, config);
        expect(res.status).toBe(204);
    });

    test("register then login round-trips a session token", async () => {
        const { config, deps } = make();
        const reg = await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        expect(reg.status).toBe(200);
        const login = await handleHttp(
            new Request("http://localhost/login", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        const data: any = await login.json();
        expect(data.sessionToken).toBeTruthy();
    });

    test("failed login returns 200 with an error body (client contract)", async () => {
        const { config, deps } = make();
        await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        const res = await handleHttp(
            new Request("http://localhost/login", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "wrongpass" }),
            }),
            deps,
            config,
        );
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.error).toBeTruthy();
        expect(data.errorCode).toBe("invalid_credentials");
        expect(data.sessionToken).toBeUndefined();
    });

    test("duplicate register returns 200 with an error body", async () => {
        const { config, deps } = make();
        await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        const res = await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.error).toBeTruthy();
        expect(data.sessionToken).toBeUndefined();
    });

    test("OPTIONS preflight is answered with CORS headers", async () => {
        const { config, deps } = make();
        const res = await handleHttp(
            new Request("http://localhost/login", {
                method: "OPTIONS",
                headers: { Origin: "http://localhost:5173" },
            }),
            deps,
            config,
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
        expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
        expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-CSRF-Token");
    });

    test("logout with a session token revokes it", async () => {
        const { config, deps } = make();
        const reg = await handleHttp(
            new Request("http://localhost/register", {
                method: "POST",
                body: JSON.stringify({ user: "routeuser", pass: "password123" }),
            }),
            deps,
            config,
        );
        const data: any = await reg.json();
        expect(data.sessionToken).toBeTruthy();

        const out = await handleHttp(
            new Request("http://localhost/auth/logout", {
                method: "POST",
                body: JSON.stringify({ sessionToken: data.sessionToken }),
            }),
            deps,
            config,
        );
        expect(out.status).toBe(204);
        expect(deps.sessions.validate(data.sessionToken)).toBeUndefined();
    });

    test("login is rate limited per IP", async () => {
        const { config, deps } = make();
        const body = JSON.stringify({ user: "routeuser", pass: "password123" });
        let last: Response | undefined;
        for (let i = 0; i < config.loginMaxPerMin + 5; i++) {
            last = await handleHttp(
                new Request("http://localhost/login", { method: "POST", body }),
                deps,
                config,
            );
        }
        expect(last!.status).toBe(429);
    });

    test("servers.ini respects EXTERNAL_URL and WOL_URL_PATH and advertises ladder endpoints", async () => {
        const config = loadConfig({ EXTERNAL_URL: "wss://game.example.com", WOL_URL_PATH: "/wol" });
        const storage = makeTestStorage();
        const accounts = new AccountStore(storage, config);
        const sessions = new SessionManager(storage, config.sessionTtlSeconds);
        const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const wol = new WolServer(config, sessions, accounts, gservs);
        const ladder = new LadderService(storage, makeTestLogger());
        const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol };
        const res = await handleHttp(new Request("http://localhost/servers.ini"), deps, config);
        const text = await res.text();
        expect(text).toContain('wolUrl="wss://game.example.com/wol"');
        expect(text).toContain('apiLoginUrl="https://game.example.com/login"');
        expect(text).toContain('apiRegUrl="https://game.example.com/register"');
        expect(text).toContain('wladderUrl="https://game.example.com/ladder"');
        expect(text).toContain('wgameresUrl="https://game.example.com/wgameres"');
    });
});
