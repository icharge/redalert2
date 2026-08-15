import { readFileSync } from "node:fs";
import path from "node:path";
import { StorageEngine } from "./storage/Storage";
import { LogLevel, parseLogLevel } from "./logger";

function loadEnvFile(env: Record<string, string | undefined>, file: string): void {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    }
    catch {
        return;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        const eq = line.indexOf("=");
        if (eq < 0) {
            continue;
        }
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        // Real environment variables always win over .env files.
        if (key && env[key] === undefined) {
            env[key] = value;
        }
    }
}

export interface ServerConfig {
    host: string;
    port: number;
    externalUrl: string;
    gameVersion: string;
    globalChannelPass: string;
    matchBotName: string;
    motd: string[];
    sessionTtlSeconds: number;
    minUsernameLength: number;
    maxUsernameLength: number;
    minPasswordLength: number;
    maxPasswordLength: number;
    freshAccountAgeSeconds: number;
    gservUrlPath: string;
    gservId: string;
    netRateMs: number;
    wolUrlPath: string;
    expectedModHash?: string;
    pingIntervalSeconds: number;
    recordReplays: boolean;
    replaysDir: string;
    corsAllowedOrigins: string[];
    logLevel: LogLevel;
    storageEngine: StorageEngine;
    dbPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): ServerConfig {
    // .env support: load server/.env then server/.env.local (the latter wins).
    // Only done when the real environment is used so tests that pass explicit
    // env objects stay deterministic. Real environment variables take precedence.
    if (env === process.env) {
        loadEnvFile(env, path.join(import.meta.dir, "..", ".env"));
        loadEnvFile(env, path.join(import.meta.dir, "..", ".env.local"));
    }
    const port = Number(env.SERVER_PORT ?? 9090);
    const externalUrl = env.EXTERNAL_URL ?? `ws://127.0.0.1:${port}`;
    const gservUrlPath = env.GSERV_URL_PATH ?? "/gserv";
    return {
        host: env.SERVER_HOST ?? "0.0.0.0",
        port,
        externalUrl,
        gameVersion: env.GAME_VERSION ?? "0.83.2",
        globalChannelPass: env.GLOBAL_CHANNEL_PASS ?? "zotclot9",
        matchBotName: env.MATCH_BOT_NAME ?? "matchbot",
        motd: (env.SERVER_MOTD ?? "Welcome to RA2Web\ngood luck and have fun").replace(/\\n/g, "\n").split("\n"),
        sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 24 * 60 * 60),
        minUsernameLength: Number(env.MIN_USERNAME_LENGTH ?? 2),
        maxUsernameLength: Number(env.MAX_USERNAME_LENGTH ?? 15),
        minPasswordLength: Number(env.MIN_PASSWORD_LENGTH ?? 8),
        maxPasswordLength: Number(env.MAX_PASSWORD_LENGTH ?? 128),
        freshAccountAgeSeconds: Number(env.FRESH_ACCOUNT_AGE_SECONDS ?? 24 * 60 * 60),
        gservUrlPath,
        gservId: env.GSERV_ID ?? "gs1",
        netRateMs: Number(env.GSERV_NET_RATE_MS ?? 33),
        wolUrlPath: env.WOL_URL_PATH ?? "",
        expectedModHash: env.EXPECTED_MOD_HASH || undefined,
        pingIntervalSeconds: Number(env.PING_INTERVAL_SECONDS ?? 30),
        recordReplays: env.RECORD_REPLAYS !== "false",
        replaysDir: env.REPLAYS_DIR ?? path.join(import.meta.dir, "..", "replays"),
        corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS
            ? env.CORS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
            : ["*"],
        logLevel: parseLogLevel(env.LOG_LEVEL),
        storageEngine: (env.STORAGE ?? "sqlite") === "memory" ? "memory" : "sqlite",
        dbPath: env.DB_PATH ?? path.join(import.meta.dir, "..", "data", "ra2web.sqlite"),
    };
}
