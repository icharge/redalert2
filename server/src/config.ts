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
    expectedModHash?: string;
    pingIntervalSeconds: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): ServerConfig {
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
        motd: (env.SERVER_MOTD ?? "Welcome to RA2Web\ngood luck and have fun").split("\n"),
        sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 24 * 60 * 60),
        minUsernameLength: Number(env.MIN_USERNAME_LENGTH ?? 2),
        maxUsernameLength: Number(env.MAX_USERNAME_LENGTH ?? 15),
        minPasswordLength: Number(env.MIN_PASSWORD_LENGTH ?? 8),
        maxPasswordLength: Number(env.MAX_PASSWORD_LENGTH ?? 128),
        freshAccountAgeSeconds: Number(env.FRESH_ACCOUNT_AGE_SECONDS ?? 24 * 60 * 60),
        gservUrlPath,
        gservId: env.GSERV_ID ?? "gs1",
        expectedModHash: env.EXPECTED_MOD_HASH || undefined,
        pingIntervalSeconds: Number(env.PING_INTERVAL_SECONDS ?? 30),
    };
}
