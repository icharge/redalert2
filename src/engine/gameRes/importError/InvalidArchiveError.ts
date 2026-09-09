export class InvalidArchiveError extends Error {
    public cause?: unknown;
    constructor(message: string, options?: {
        cause?: unknown;
    }) {
        super(message);
        this.name = "InvalidArchiveError";
        if (options?.cause) {
            this.cause = options.cause;
        }
        Object.setPrototypeOf(this, InvalidArchiveError.prototype);
    }
}
