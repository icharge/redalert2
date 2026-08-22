// Server-side validator for the client's auto-submitted crash/desync report.
// The wire format is a single 7z archive POSTed to /errorreport/{sku} (see
// src/network/ErrorReportService.ts) containing a "report.json" entry that
// decodes to the shape validated here, plus an optional opaque
// "desync-debug.json" entry this server never parses (server/src/diagnostics/
// errorReportArchive.ts pulls report.json's bytes out of the archive and
// hands them to validateErrorReport() below; the whole archive is then
// persisted byte-for-byte by errorReportStore.ts). The validation shape
// mirrors gameResCodec's binary GameRes packet: a single
// validateErrorReport(body) that throws a typed error on any failure, so the
// route handler can 400 with a consistent errorCode the same way it does for
// GameResDecodeError. See ERROR_REPORTING_PLAN.md's "Validity checking" section.

export const ERROR_TYPES = [
    "desync_error",
    "game_load_error",
    "ui_init_error",
    "game_crash",
    "connection_error",
    "other",
] as const;

export type ErrorReportType = typeof ERROR_TYPES[number];

// getHashBreakdown()'s exact key set (src/game/Game.ts) — this list is a
// contract with that method, not an arbitrary schema choice.
const HASH_BREAKDOWN_KEYS = [
    "currentTick",
    "lastRandom",
    "nextObjectId",
    "objectCount",
    "objectsHash",
    "playersHash",
    "creditsSum",
    "alliancesHash",
    "gameTraitsHash",
] as const;

// Reject rather than truncate an oversized objectHashes array: a truncated
// object list would silently corrupt the diff logic in GservManager, whereas
// message/stack truncation below only loses log verbosity.
const MAX_OBJECT_HASHES = 20_000;
const MAX_GAME_ID_LENGTH = 128;
const MAX_NICK_LENGTH = 64;
const MAX_CLIENT_VERSION_LENGTH = 64;
const MAX_OBJECT_NAME_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_STACK_LENGTH = 20_000;

export interface ErrorReportObjectHash {
    id: number;
    name: string;
    hash: number;
}

export interface ErrorReportGameState {
    tick: number;
    hashBreakdown: Record<string, number>;
    objectHashes: ErrorReportObjectHash[];
}

export interface ErrorReport {
    gameId: string;
    nick: string;
    errorType: ErrorReportType;
    message: string;
    stack?: string;
    timestamp: number;
    clientVersion: string;
    gameState?: ErrorReportGameState;
}

export class ErrorReportValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ErrorReportValidationError";
    }
}

function requireString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ErrorReportValidationError(`missing or invalid "${field}"`);
    }
    return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function requireFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ErrorReportValidationError(`missing or invalid "${field}"`);
    }
    return value;
}

function validateHashBreakdown(value: unknown): Record<string, number> {
    if (typeof value !== "object" || value === null) {
        throw new ErrorReportValidationError(`"gameState.hashBreakdown" must be an object`);
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const key of HASH_BREAKDOWN_KEYS) {
        result[key] = requireFiniteNumber(record[key], `gameState.hashBreakdown.${key}`);
    }
    return result;
}

function validateObjectHashes(value: unknown): ErrorReportObjectHash[] {
    if (!Array.isArray(value)) {
        throw new ErrorReportValidationError(`"gameState.objectHashes" must be an array`);
    }
    if (value.length > MAX_OBJECT_HASHES) {
        throw new ErrorReportValidationError(`"gameState.objectHashes" too large (${value.length} > ${MAX_OBJECT_HASHES})`);
    }
    return value.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new ErrorReportValidationError(`"gameState.objectHashes[${index}]" must be an object`);
        }
        const record = entry as Record<string, unknown>;
        return {
            id: requireFiniteNumber(record.id, `gameState.objectHashes[${index}].id`),
            name: requireString(record.name, `gameState.objectHashes[${index}].name`, MAX_OBJECT_NAME_LENGTH),
            hash: requireFiniteNumber(record.hash, `gameState.objectHashes[${index}].hash`),
        };
    });
}

function validateGameState(value: unknown): ErrorReportGameState | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "object" || value === null) {
        throw new ErrorReportValidationError(`"gameState" must be an object`);
    }
    const record = value as Record<string, unknown>;
    return {
        tick: requireFiniteNumber(record.tick, "gameState.tick"),
        hashBreakdown: validateHashBreakdown(record.hashBreakdown),
        objectHashes: validateObjectHashes(record.objectHashes),
    };
}

export function validateErrorReport(body: unknown): ErrorReport {
    if (typeof body !== "object" || body === null) {
        throw new ErrorReportValidationError("body must be a JSON object");
    }
    const record = body as Record<string, unknown>;
    const errorType = record.errorType;
    if (typeof errorType !== "string" || !(ERROR_TYPES as readonly string[]).includes(errorType)) {
        throw new ErrorReportValidationError(`invalid "errorType" (must be one of ${ERROR_TYPES.join(", ")})`);
    }
    return {
        gameId: requireString(record.gameId, "gameId", MAX_GAME_ID_LENGTH),
        nick: requireString(record.nick, "nick", MAX_NICK_LENGTH),
        errorType: errorType as ErrorReportType,
        message: requireString(record.message, "message", MAX_MESSAGE_LENGTH),
        stack: typeof record.stack === "string" ? record.stack.slice(0, MAX_STACK_LENGTH) : undefined,
        timestamp: requireFiniteNumber(record.timestamp, "timestamp"),
        clientVersion: requireString(record.clientVersion, "clientVersion", MAX_CLIENT_VERSION_LENGTH),
        gameState: validateGameState(record.gameState),
    };
}
