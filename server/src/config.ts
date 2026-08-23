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
    maxPayloadBytes: number;
    instanceTtlSeconds: number;
    startTimeoutSeconds: number;
    reconnectGraceSeconds: number;
    loadingDepartureGraceSeconds: number;
    abandonedInstanceTimeoutSeconds: number;
    pauseCountdownMillis: number;
    pauseCooldownMillis: number;
    rejoinResumeCountdownMillis: number;
    voteMinRequiredPlayers: number;
    voteExtensionsMax: number;
    voteExtensionSeconds: number;
    voteOpenDelayMillis: number;
    gservRateLimitEnabled: boolean;
    gservStatsIntervalSeconds: number;
    loginMaxPerMin: number;
    registerMaxPerHour: number;
    recordReplays: boolean;
    replaysDir: string;
    corsAllowedOrigins: string[];
    logLevel: LogLevel;
    logFilePath: string;
    logMaxBytes: number;
    logMaxFiles: number;
    logRotateDaily: boolean;
    storageEngine: StorageEngine;
    dbPath: string;
    startingRating: number;
    placementMatches: number;
    minReportDurationSeconds: number;
    gservReportWindowSeconds: number;
    adminUsernames: string[];
    /** Public origin of the game client (for admin console replay deeplinks). */
    clientUrl?: string;
    // Auto-submitted crash/desync diagnostic reports (see ERROR_REPORTING_PLAN.md).
    errorReportsDir: string;
    desyncReportTimeoutMillis: number;
    maxErrorReportBytes: number;
    errorReportMaxPerMin: number;
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
        gameVersion: env.GAME_VERSION ?? "0.83.4",
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
        maxPayloadBytes: Number(env.MAX_PAYLOAD_BYTES ?? 256 * 1024),
        instanceTtlSeconds: Number(env.GSERV_INSTANCE_TTL_SECONDS ?? 600),
        startTimeoutSeconds: Number(env.GSERV_START_TIMEOUT_SECONDS ?? 180),
        // How long the relay holds (game pauses) for a departed player to rejoin
        // mid-game before their turns are backfilled and play continues.
        reconnectGraceSeconds: Number(env.GSERV_RECONNECT_GRACE_SECONDS ?? 30),
        // How long a player who dropped during the loading phase has to rejoin
        // before the instance is aborted for the remaining players.
        loadingDepartureGraceSeconds: Number(env.GSERV_LOADING_DEPARTURE_GRACE_SECONDS ?? 90),
        // When the last connected human leaves an instance that still has
        // bots (or other departed-but-not-yet-expired humans) in it, every
        // pending rejoin deadline is extended to this many seconds instead of
        // the shorter per-player reconnectGraceSeconds, since nobody is left
        // to notice the match ending early. 0 holds the instance indefinitely
        // (never auto-finalizes; only an explicit rejoin or admin action ends
        // it).
        abandonedInstanceTimeoutSeconds: Number(env.GSERV_ABANDONED_TIMEOUT_SECONDS ?? 120),
        // MOBA-style whole-game pause countdown and per-player cooldown.
        pauseCountdownMillis: Number(env.GSERV_PAUSE_COUNTDOWN_MILLIS ?? 3000),
        pauseCooldownMillis: Number(env.GSERV_PAUSE_COOLDOWN_MILLIS ?? 30000),
        // Countdown between a rejoining player signalling ready and the relay
        // resuming, so everyone is ready to continue.
        rejoinResumeCountdownMillis: Number(env.GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS ?? 3000),
        // Kick/wait voting on a mid-game departure. Only offered when at least
        // this many players are still required by the relay at the moment
        // someone drops -- below it (i.e. a 1v1) a "majority" would be a single
        // player unilaterally deciding another's fate, so the plain grace timer
        // decides instead.
        voteMinRequiredPlayers: Number(env.GSERV_VOTE_MIN_REQUIRED_PLAYERS ?? 3),
        // A "wait" vote vetoes a kick, but only while extensions remain: each
        // one pushes the departed player's deadline out by
        // voteExtensionSeconds. Once the pool is spent, wait votes are advisory
        // and a kick majority carries -- so one holdout cannot stall a match
        // indefinitely, but the group can still buy a reconnecting player a
        // bounded amount of extra time.
        voteExtensionsMax: Number(env.GSERV_VOTE_EXTENSIONS_MAX ?? 2),
        voteExtensionSeconds: Number(env.GSERV_VOTE_EXTENSION_SECONDS ?? 30),
        // A drop is very often just a brief network blip that resolves itself
        // in a few seconds -- the connection-info screen can already open off
        // a much shorter lag heuristic client-side (LAG_STATE_THRESH_MILLIS,
        // ~1s) or the moment the socket actually closes, well before anyone
        // should be asked to weigh in on kicking someone. The vote itself only
        // becomes available after this much longer delay, and only if the
        // player is still away when it elapses -- a reconnect within the
        // window cancels it outright, never opening at all.
        voteOpenDelayMillis: Number(env.GSERV_VOTE_OPEN_DELAY_MILLIS ?? 10_000),
        // Disable per-connection flood limiting on the match relay (testing
        // only): set GSERV_RATE_LIMIT=disabled to turn it off.
        gservRateLimitEnabled: env.GSERV_RATE_LIMIT !== "disabled",
        // Every N seconds, active games log received frames/s and relayed
        // ticks/s per player (0 disables). Lets you watch real packet rates
        // during play instead of guessing.
        gservStatsIntervalSeconds: Number(env.GSERV_STATS_INTERVAL_SECONDS ?? 5),
        loginMaxPerMin: Number(env.LOGIN_MAX_PER_MIN ?? 30),
        registerMaxPerHour: Number(env.REGISTER_MAX_PER_HOUR ?? 20),
        recordReplays: env.RECORD_REPLAYS === "true",
        replaysDir: env.REPLAYS_DIR ?? path.join(import.meta.dir, "..", "replays"),
        corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS
            ? env.CORS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
            : ["*"],
        logLevel: parseLogLevel(env.LOG_LEVEL),
        // Rotating log file written by the server itself ("" disables file
        // logging; relative paths are resolved against the working directory,
        // like DB_PATH).
        logFilePath: env.LOG_FILE ?? "data/server.log",
        logMaxBytes: Number(env.LOG_MAX_BYTES ?? 100 * 1024 * 1024),
        logMaxFiles: Number(env.LOG_MAX_FILES ?? 5),
        logRotateDaily: env.LOG_ROTATE_DAILY !== "false",
        storageEngine: (env.STORAGE ?? "sqlite") === "memory" ? "memory" : "sqlite",
        // Relative to the working directory the server was started from
        // (systemctl WorkingDirectory or wherever `bun run` was invoked),
        // so the database travels with the install location.
        dbPath: env.DB_PATH ?? path.join(process.cwd(), "data", "ra2web.sqlite"),
        // Ranked ladder (see server/src/ladder/rating.ts for the model).
        startingRating: Number(env.STARTING_RATING ?? 1000),
        placementMatches: Number(env.PLACEMENT_MATCHES ?? 10),
        // Game-res reports shorter than this are rejected (anti-farm): a real
        // ranked game never ends in under two minutes.
        minReportDurationSeconds: Number(env.MIN_REPORT_DURATION_SECONDS ?? 120),
        // How long ended ranked instances keep their metadata after the last
        // player disconnects, so late/retried game-res reports (client retries
        // for up to 5 minutes) can still be validated. After this the gameId
        // is forgotten and can never be re-reported.
        gservReportWindowSeconds: Number(env.GSERV_REPORT_WINDOW_SECONDS ?? 600),
        // Usernames allowed into the /admin console (comma-separated). The
        // console manages seasons and browses ladder data; there is no role
        // stored in the database.
        adminUsernames: env.ADMIN_USERNAMES
            ? env.ADMIN_USERNAMES.split(",").map(name => name.trim().toLowerCase()).filter(Boolean)
            : [],
        clientUrl: env.CLIENT_URL?.trim() || undefined,
        // Auto-submitted crash/desync diagnostic reports (see ERROR_REPORTING_PLAN.md).
        // Reports collect per-gameId, mirroring replaysDir's directory-per-artifact layout.
        errorReportsDir: env.ERROR_REPORTS_DIR ?? path.join(import.meta.dir, "..", "error-reports"),
        // How long the server waits after a desync_error report arrives before
        // giving up on a second peer's report to diff against, and persisting
        // whatever it has. Non-desync errorTypes never wait (nothing to correlate).
        desyncReportTimeoutMillis: Number(env.GSERV_DESYNC_REPORT_TIMEOUT_MILLIS ?? 5000),
        // Upper bound on a report's raw JSON body size, checked before JSON.parse
        // (same early-reject-on-size principle as maxSnapshotBytes). A getObjectHashList()
        // payload runs roughly 15-40 bytes/object, well under this.
        maxErrorReportBytes: Number(env.GSERV_MAX_ERROR_REPORT_BYTES ?? 4 * 1024 * 1024),
        // Per-IP limiter (no mandatory auth on this endpoint, so no account to key by).
        errorReportMaxPerMin: Number(env.GSERV_ERROR_REPORT_MAX_PER_MIN ?? 20),
    };
}
