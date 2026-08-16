export interface AdminConfig {
    clientUrl?: string;
    apiUrl?: string;
}

// Minimal fetch wrapper: Bearer token, JSON handling, consistent errors.
// In dev the Vite server proxies /login and /admin to the local Bun server;
// in production the console is served from an origin listed in
// CORS_ALLOWED_ORIGINS and talks to the API directly.

export class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

let token: string | undefined;

export function setToken(value: string | undefined): void {
    token = value;
    if (value) {
        localStorage.setItem("admin-token", value);
    }
    else {
        localStorage.removeItem("admin-token");
    }
}

export function getStoredToken(): string | undefined {
    if (token === undefined) {
        token = localStorage.getItem("admin-token") ?? undefined;
    }
    return token;
}

// Called when the server rejects a request as unauthorized (expired/revoked
// session token) so the app can switch back to the login view immediately
// instead of leaving the user stuck on a console that 401s on every call.
let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
    unauthorizedHandler = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    const currentToken = getStoredToken();
    if (currentToken) {
        headers["authorization"] = "Bearer " + currentToken;
    }
    let response: Response;
    try {
        response = await fetch(path, { ...init, headers });
    }
    catch {
        throw new ApiError("Network error", 0);
    }
    if (response.status === 401) {
        setToken(undefined);
        unauthorizedHandler?.();
    }
    if (!response.ok) {
        let message = "HTTP " + response.status;
        try {
            const body = await response.json();
            if (body?.error) {
                message = String(body.error);
            }
        }
        catch {
            // non-JSON error body
        }
        throw new ApiError(message, response.status);
    }
    return await response.json() as T;
}

export const api = {
    adminConfig(): Promise<AdminConfig> {
        return request("/admin/config");
    },
    login(user: string, pass: string): Promise<{ user: string; sessionToken: string }> {
        return request("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user, pass }),
        });
    },
    dashboard(): Promise<Dashboard> {
        return request("/admin/dashboard");
    },
    seasons(): Promise<SeasonStats[]> {
        return request("/admin/seasons");
    },
    createSeason(name: string, sku: number, startTime?: number, endTime?: number): Promise<SeasonStats> {
        return request("/admin/seasons", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, sku, startTime, endTime }),
        });
    },
    closeSeason(sku: number, id: number): Promise<{ ok: boolean }> {
        return request(`/admin/seasons/${id}/close?sku=${sku}`, { method: "POST" });
    },
    matches(limit = 50, player?: string): Promise<AdminMatch[]> {
        const params = new URLSearchParams({ limit: String(limit) });
        if (player) {
            params.set("player", player);
        }
        return request("/admin/matches?" + params.toString());
    },
    searchPlayers(q: string, limit = 20): Promise<PlayerSearchResult[]> {
        return request(`/admin/players?q=${encodeURIComponent(q)}&limit=${limit}`);
    },
    playerHistory(name: string, season?: string, ladderType?: string): Promise<PlayerHistory> {
        const params = new URLSearchParams();
        if (season) {
            params.set("season", season);
        }
        if (ladderType) {
            params.set("ladderType", ladderType);
        }
        const query = params.toString();
        return request(`/admin/players/${encodeURIComponent(name)}` + (query ? "?" + query : ""));
    },
    replays(limit = 50): Promise<ReplayEntry[]> {
        return request(`/admin/replays?limit=${limit}`);
    },
    replayFiles(): Promise<ReplayFileEntry[]> {
        return request("/admin/replay-files");
    },
    backfillReplays(): Promise<{ linked: number }> {
        return request("/admin/replay-files/backfill", { method: "POST" });
    },
    async downloadReplay(gameId: string, fileName: string): Promise<void> {
        const currentToken = getStoredToken();
        const response = await fetch(`/admin/replays/${encodeURIComponent(gameId)}`, {
            headers: currentToken ? { authorization: "Bearer " + currentToken } : {},
        });
        if (!response.ok) {
            throw new ApiError("Download failed: HTTP " + response.status, response.status);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
    },
};

export interface ReplayEntry {
    gameId: string;
    seasonId: number;
    ladderType: string;
    reportedAt: number;
    scored: boolean;
    mapName?: string;
    players: { name: string; resultType: number }[];
    replayFile: string;
    sizeBytes: number;
}

export interface ReplayFileEntry {
    fileName: string;
    gameId: string;
    sizeBytes: number;
    mtimeMs: number;
    inDb: boolean;
}

// Builds the in-game replay deeplink: game client URL + #/replay/<base64url>
// pointing at the public replay endpoint. URL-safe base64 keeps the hash
// free of characters that would break routing.
export function buildReplayLink(gameUrl: string, replayApiUrl: string, entry: ReplayEntry): string {
    const payload = JSON.stringify({ url: `${replayApiUrl}/replays/${entry.gameId}`, name: entry.replayFile });
    const base64 = btoa(unescape(encodeURIComponent(payload)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `${gameUrl.replace(/\/$/, "")}#/replay/${base64}`;
}

import type { AdminMatch, Dashboard, PlayerHistory, PlayerSearchResult, SeasonStats } from "./types";
