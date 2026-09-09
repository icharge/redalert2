export class ArchiveDownloadError extends Error {
    public url: string;
    public cause?: unknown;
    constructor(url: string, message: string, options?: {
        cause?: unknown;
    }) {
        super(message);
        this.name = "ArchiveDownloadError";
        this.url = url;
        if (options?.cause) {
            this.cause = options.cause;
        }
    }
}
