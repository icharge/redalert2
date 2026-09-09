import { HttpRequest, DownloadError } from "@/network/HttpRequest";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { isBetween } from "@/util/math";
import type { WolService } from "@/network/WolService";
import type { CancellationToken } from "@puzzl/core/lib/async/cancellation";

export class MapTransferService {
    private url?: string;

    constructor(private wolService: WolService, private httpRequest: HttpRequest = new HttpRequest()) {
    }

    setUrl(url: string): void {
        this.url = url;
    }

    getUrl(): string | undefined {
        return this.url;
    }

    async putMap(data: ArrayBuffer, mapName: string, cancellationToken?: CancellationToken): Promise<void> {
        if (!this.url) {
            throw new Error("No MapTransfer URL is set");
        }
        const authorization = this.makeAuthorizationHeader();
        let lastError: DownloadError | undefined;
        let retries = 3;
        while (retries--) {
            try {
                console.log("Uploading map...", retries + 1, "retries left");
                cancellationToken?.throwIfCancelled();
                await this.httpRequest.fetchRaw(this.url + "/" + mapName, cancellationToken, {
                    method: "PUT",
                    body: data,
                    headers: {
                        authorization,
                        "Content-Type": "application/octet-stream",
                    },
                });
                console.log(`Map upload finished. (size=${data.byteLength})`);
                return;
            }
            catch (error) {
                if (!(error instanceof DownloadError) || (error.statusCode && isBetween(error.statusCode, 400, 499))) {
                    throw error;
                }
                lastError = error;
                await sleep(1000, cancellationToken);
            }
        }
        throw lastError;
    }

    async getMap(mapName: string, cancellationToken?: CancellationToken): Promise<ArrayBuffer> {
        if (!this.url) {
            throw new Error("No MapTransfer URL is set");
        }
        const authorization = this.makeAuthorizationHeader();
        let lastError: DownloadError | undefined;
        let retries = 6;
        while (retries--) {
            try {
                console.log("Transferring map...", retries + 1, "retries left");
                cancellationToken?.throwIfCancelled();
                const data = await this.httpRequest.fetchBinary(this.url + "/" + mapName, cancellationToken, {
                    headers: {
                        authorization,
                    },
                });
                console.log(`Map download finished. (size=${data.byteLength})`);
                return data;
            }
            catch (error) {
                if (!(error instanceof DownloadError && error.statusCode === 404)) {
                    throw error;
                }
                lastError = error;
                await sleep(3000, cancellationToken);
            }
        }
        throw lastError;
    }

    private makeAuthorizationHeader(): string {
        const session = this.wolService.getSession();
        if (!session?.sessionToken) {
            throw new Error("Missing WOL session token");
        }
        return "Bearer " + session.sessionToken;
    }
}
