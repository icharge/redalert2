export class NoWebAssemblyError extends Error {
    public cause?: unknown;
    constructor(message: string, options?: {
        cause?: unknown;
    }) {
        super(message);
        this.name = "NoWebAssemblyError";
        if (options?.cause) {
            this.cause = options.cause;
        }
        Object.setPrototypeOf(this, NoWebAssemblyError.prototype);
    }
}
