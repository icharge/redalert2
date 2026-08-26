import { HttpRequest, DownloadError, type FetchOptions } from "@/network/HttpRequest";
import type { CancellationToken } from "@puzzl/core/lib/async/cancellation";

export class CfChallengeHttpRequest extends HttpRequest {
    constructor(private cfChallengeHandler?: () => Promise<void>) {
        super();
    }

    async fetchRaw(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<ArrayBuffer> {
        return await this.fetchAndRetry(() => super.fetchRaw(url, cancellationToken, this.prepareOptions(options)));
    }

    private prepareOptions(options?: FetchOptions): FetchOptions {
        return {
            ...options,
            credentials: options?.credentials ?? "include",
        };
    }

    private async fetchAndRetry(fetch: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
        try {
            return await fetch();
        }
        catch (error) {
            if (!this.isCloudflareChallenge(error) || !this.cfChallengeHandler) {
                throw error;
            }
            console.warn("Cloudflare challenge detected; attempting pre-clearance", error);
            try {
                await this.cfChallengeHandler();
            }
            catch (handlerError) {
                console.warn("Cloudflare pre-clearance failed", handlerError);
                throw error;
            }
            return await fetch();
        }
    }

    private isCloudflareChallenge(error: unknown): boolean {
        return error instanceof DownloadError && error.headers["cf-mitigated"] === "challenge";
    }
}
