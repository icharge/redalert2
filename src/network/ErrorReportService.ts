import { OperationCanceledError } from "@puzzl/core/lib/async/cancellation";
import { Task } from "@puzzl/core/lib/async/Task";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { HttpRequest, DownloadError } from "@/network/HttpRequest";
import { isBetween } from "@/util/math";
import { ERROR_REPORT_RETRY_DURATION_MILLIS } from "@/network/errorReport/errorReportConfig";
import type { WolConfig } from "@/network/WolConfig";

export type ErrorReportType =
    | "desync_error"
    | "game_load_error"
    | "ui_init_error"
    | "game_crash"
    | "connection_error"
    | "other";

export interface ErrorReportGameState {
    tick: number;
    hashBreakdown: Record<string, number>;
    objectHashes: Array<{ id: number; name: string; hash: number }>;
}

export interface ErrorReportPayload {
    gameId: string;
    nick: string;
    errorType: ErrorReportType;
    message: string;
    stack?: string;
    timestamp: number;
    clientVersion: string;
    gameState?: ErrorReportGameState;
    // Base64 of a 7z-compressed { stateDump, lockstepLog } bundle (see
    // GameScreen.initOnlineLockstep's desync callback) -- the full per-turn
    // history that lets a developer pinpoint *when* two clients' state first
    // diverged, not just that they currently differ. Only ever populated for
    // desync_error reports with debugGameState enabled.
    debugBundle?: string;
}

// Mirrors WGameResService almost exactly (same retry-within-a-deadline shape),
// but posts a plain JSON body instead of a binary GameRes packet, and its auth
// is opportunistic rather than required: the server (see server/src/http/routes.ts's
// handleErrorReport) accepts the report with or without a valid session token,
// since single-player/LAN play has no guaranteed WOL session to attach.
export class ErrorReportService {
    static MIN_RETRY_MILLIS = 2_000;
    static MAX_RETRY_MILLIS = 15_000;

    private url?: string;
    private sendTask?: Task<void>;

    constructor(private wolService: any, private wolConfig: WolConfig, private httpRequest: HttpRequest = new HttpRequest()) {
    }

    setUrl(url: string): void {
        this.url = url;
    }

    getUrl(): string | undefined {
        return this.url;
    }

    async submit(report: ErrorReportPayload, cancellationToken?: any): Promise<void> {
        if (!this.url) {
            throw new Error("No error report URL is set");
        }
        const url = this.url;
        const gameSku = this.wolConfig.getClientSku();
        const body = JSON.stringify(report);
        const sessionToken = this.wolService.getSession?.()?.sessionToken;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (sessionToken) {
            headers.authorization = "Bearer " + sessionToken;
        }
        this.sendTask?.cancel();
        const task = this.sendTask = new Task<void>(async (token) => {
            let attempts = 0;
            const deadline = Date.now() + ERROR_REPORT_RETRY_DURATION_MILLIS;
            try {
                for (;;) {
                    try {
                        await this.httpRequest.fetchRaw(url + "/" + gameSku, token, {
                            method: "POST",
                            body,
                            headers,
                        });
                        return;
                    }
                    catch (error) {
                        if (error instanceof OperationCanceledError) {
                            throw error;
                        }
                        if (error instanceof DownloadError && error.statusCode && isBetween(error.statusCode, 400, 499)) {
                            throw error;
                        }
                        attempts++;
                        const retryMillis = this.getRetryMillis(attempts);
                        if (Date.now() + retryMillis > deadline) {
                            throw new Error(`Failed sending error report after ${attempts} attempts ` +
                                `within ${ERROR_REPORT_RETRY_DURATION_MILLIS}ms`);
                        }
                        console.warn(`Failed sending error report, retrying in ${retryMillis}ms (attempt ${attempts})`, error);
                        await sleep(retryMillis, token);
                    }
                }
            }
            finally {
                if (this.sendTask === task) {
                    this.sendTask = undefined;
                }
            }
        });
        cancellationToken?.register(() => task.cancel());
        await task.start();
    }

    dispose(): void {
        this.sendTask?.cancel();
        this.sendTask = undefined;
    }

    private getRetryMillis(attempt: number): number {
        return Math.min(ErrorReportService.MAX_RETRY_MILLIS, ErrorReportService.MIN_RETRY_MILLIS * Math.pow(2, Math.max(0, attempt - 1)));
    }
}
