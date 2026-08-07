import { OperationCanceledError } from "@puzzl/core/lib/async/cancellation";
import { Task } from "@puzzl/core/lib/async/Task";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { HttpRequest, DownloadError } from "@/network/HttpRequest";
import { uint8ArrayToBase64String } from "@/util/string";
import { isBetween } from "@/util/math";
import { GAME_RES_RETRY_DURATION_MILLIS } from "@/network/gameres/wgameResConfig";
import type { WolConfig } from "@/network/WolConfig";

export class WGameResService {
    static MIN_RETRY_MILLIS = 2_000;
    static MAX_RETRY_MILLIS = 30_000;

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

    async sendGameResPacket(packet: Uint8Array, cancellationToken?: any): Promise<void> {
        if (!this.url) {
            throw new Error("No WGameRes URL is set");
        }
        const session = this.wolService.getSession();
        if (!session?.sessionToken) {
            throw new Error("Missing WOL session token");
        }
        const url = this.url;
        const gameSku = this.wolConfig.getClientSku();
        const body = uint8ArrayToBase64String(packet);
        const authorization = "Bearer " + session.sessionToken;
        this.sendTask?.cancel();
        const task = this.sendTask = new Task<void>(async (token) => {
            let attempts = 0;
            const deadline = Date.now() + GAME_RES_RETRY_DURATION_MILLIS;
            try {
                for (;;) {
                    try {
                        await this.httpRequest.fetchRaw(url + "/" + gameSku, token, {
                            method: "POST",
                            body,
                            headers: {
                                authorization,
                            },
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
                            throw new Error(`Failed sending gameres packet after ${attempts} attempts ` +
                                `within ${GAME_RES_RETRY_DURATION_MILLIS}ms`);
                        }
                        console.warn(`Failed sending gameres packet, retrying in ${retryMillis}ms (attempt ${attempts})`, error);
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
        return Math.min(WGameResService.MAX_RETRY_MILLIS, WGameResService.MIN_RETRY_MILLIS * Math.pow(2, Math.max(0, attempt - 1)));
    }
}
