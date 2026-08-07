import { HttpRequest, DownloadError } from "@/network/HttpRequest";

export class CfChallengeHttpRequest extends HttpRequest {
    constructor(private cfChallengeHandler?: () => Promise<void>) {
        super();
    }

    async fetchRaw(url: string, cancellationToken?: any, options?: any): Promise<ArrayBuffer> {
        return await this.fetchAndRetry(() => super.fetchRaw(url, cancellationToken, this.prepareOptions(options)));
    }

    private prepareOptions(options: any): any {
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

    private isCloudflareChallenge(error: any): boolean {
        return error instanceof DownloadError && error.headers["cf-mitigated"] === "challenge";
    }
}
