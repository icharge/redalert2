import { HttpDeps } from "./routes";
import { ServerConfig } from "../config";
import { decodeNativeGameRes, NativeResultError, NATIVE_RESULT_MAX, nativeResultType } from "../ladder/nativeGameRes";
import { withCors } from "./cors";
import { WdtError } from "../wdt/types";
import { WdtService } from "../wdt/service";
import { GservInstance } from "../gserv/GservManager";

/** Apply a WDT instance's result from a decoded native report. Exported so the
 * side-map/winner rules are unit-testable without building a whole packet. */
export function applyWdtNativeResult(
    wdt: WdtService | undefined,
    instance: Pick<GservInstance, "gameId" | "wdtConflictId" | "wdtSides">,
    report: { players: Array<{ name: string; completionStatus: number }> },
    gameId: string,
): { conflictId: number; winner: number } | undefined {
    if (!wdt || instance.wdtConflictId === undefined) return undefined;
    const winner = report.players.find(player => nativeResultType(player.completionStatus) === 0);
    const nick = winner?.name.toLowerCase();
    const row = nick
        ? Object.entries(instance.wdtSides ?? {}).find(([name]) => name.toLowerCase() === nick)?.[1]
        : undefined;
    if (row === undefined) return undefined;
    wdt.reportResult({ conflictId: instance.wdtConflictId, winner: row, gameId });
    return { conflictId: instance.wdtConflictId, winner: row };
}

/** Native history ingestion deliberately cannot enter the ranked scoring path. */
export async function handleNativeResults(req: Request, deps: HttpDeps, config: ServerConfig, gameId: string): Promise<Response> {
    const reply = (body: unknown, status: number) => withCors(Response.json(body, { status }), config, req);
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const session = token && deps.sessions.validate(token);
    if (!session) return reply({ error: "Unauthorized" }, 401);
    const instance = deps.gservs.get(gameId);
    if (!instance || instance.ranked || !instance.nativeSku) return reply({ error: "Unknown native custom match" }, 404);
    if (!instance.players.some(nick => nick.toLowerCase() === session.username.toLowerCase())) return reply({ error: "Not a match participant" }, 403);
    if (instance.endedAt !== undefined && Date.now() / 1000 - instance.endedAt > config.gservReportWindowSeconds) return reply({ error: "Report window closed" }, 410);
    // Stream a bounded body; do not allocate an arbitrary attacker-controlled request.
    const reader = req.body?.getReader();
    if (!reader) return reply({ error: "Missing packet" }, 400);
    try {
        const chunks: Uint8Array[] = []; let length = 0;
        for (;;) {
            const next = await reader.read(); if (next.done) break;
            length += next.value.length;
            if (length > NATIVE_RESULT_MAX) { await reader.cancel(); return reply({ error: "Packet too large" }, 413); }
            chunks.push(next.value);
        }
        const report = decodeNativeGameRes(Buffer.concat(chunks));
        const number = /^g([1-9]\d*)-/.exec(gameId)?.[1];
        if (report.sku !== instance.nativeSku || report.gameNumber !== Number(number)) throw new NativeResultError("Match context mismatch");
        const names = new Set(report.players.map(p => p.name.toLowerCase()));
        if (instance.players.some(nick => !names.has(nick.toLowerCase()))) throw new NativeResultError("Roster mismatch");
        // Native reports include AI house records in some modes. Additional names
        // remain client-reported; AIPL bounds them, never authenticates them.
        if (report.aiPlayers > 7 || report.players.length - instance.players.length > report.aiPlayers) throw new NativeResultError("Unexpected players");
        deps.ladder.recordNativeReport(gameId, session.username, report, instance.players);
        // A WDT match settles the conflict it was assigned. The winning player
        // is the one whose native completion status is a win; the instance's
        // side map turns that nick into the owner row.
        let wdt: { conflictId: number; winner: number } | undefined;
        try {
            wdt = applyWdtNativeResult(deps.wdt, instance, report, gameId);
        }
        catch (error) {
            if (error instanceof WdtError) return reply({ error: error.message }, 409);
            throw error;
        }
        return reply({ gameId, stored: true, ranked: false, ...(wdt ? { wdt } : {}) }, 200);
    } catch (error) {
        if (error instanceof NativeResultError) return reply({ error: error.message }, error.status);
        throw error;
    } finally { reader.releaseLock(); }
}
