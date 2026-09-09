import { IOError } from "./IOError";
export class NameNotAllowedError extends IOError {
    constructor(message: string = "File name is not allowed", cause?: Error) {
        super(message);
        this.name = "NameNotAllowedError";
        if (cause && this instanceof Error) {
            (this as unknown as { cause?: unknown }).cause = cause;
        }
        Object.setPrototypeOf(this, NameNotAllowedError.prototype);
    }
}
