import { OperationCanceledError, type CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { EventDispatcher } from "@/util/event";
import { AppLogger } from "@/util/logger";
import { uint8ArrayToBinaryString, binaryStringToUint8Array } from "@/util/string";
import { sleep } from "@/util/time";
import type { Logger } from "@/network/Logger";

interface IrcConnectionOptions {
    mode: "text" | "binary";
    binaryReqPrefix?: number;
    binaryRplPrefix?: number;
    logFilter?: (message: string) => string;
}

export interface ConnectOptions {
    timeoutSeconds?: number;
    cancelToken?: CancellationToken;
}

export interface IrcRawReply {
    raw: string;
    code?: number;
    params?: string[];
    time: number;
}

interface SendCommandOptions {
    replyStartCode?: number;
    replyBodyCodes?: number[];
    replyEndCode?: number;
    replyCodes?: number[] | [number, (reply: IrcRawReply) => boolean][];
    replyMatch?: RegExp;
    replyRawText?: boolean;
    replyHeartbeatCodes?: number[];
    heartbeatTimeout?: number;
    timeout?: number;
}

export class IrcConnection {
    static NoReplyError = class NoReplyError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'NoReplyError';
        }
    };
    static SocketError = class SocketError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'SocketError';
        }
    };
    static ConnectError = class ConnectError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'ConnectError';
        }
    };

    private socket?: WebSocket;
    private timeout: number = 5;
    private _onMessage = new EventDispatcher<IrcConnection, string | Uint8Array>();
    private _onError = new EventDispatcher<IrcConnection, Event>();
    private _onClose = new EventDispatcher<IrcConnection, CloseEvent>();
    private messageBuffer: string = "";

    constructor(private options: IrcConnectionOptions, private logger: Logger = AppLogger.get("irc")) {
    }

    get onMessage() {
        return this._onMessage.asEvent();
    }

    get onError() {
        return this._onError.asEvent();
    }

    get onClose() {
        return this._onClose.asEvent();
    }

    async connect(url: string, options?: ConnectOptions): Promise<void> {
        const timeoutId = options?.timeoutSeconds ? setTimeout(() => this.close(), 1000 * options.timeoutSeconds) : undefined;
        options?.cancelToken?.register(() => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            this.close();
        });
        return new Promise<void>((resolve, reject) => {
            this.socket = new WebSocket(url);
            if (this.socket.binaryType !== "arraybuffer") {
                this.socket.binaryType = "arraybuffer";
            }
            const handleError = (event: Event) => {
                this.socket?.removeEventListener("error", handleError);
                if (options?.cancelToken?.isCancelled()) {
                    reject(new OperationCanceledError(options.cancelToken));
                }
                else {
                    reject(new IrcConnection.ConnectError(`Connection to "${url}" failed`));
                }
            };
            this.socket.addEventListener("open", () => {
                this.socket?.removeEventListener("error", handleError);
                this.socket?.addEventListener("error", (errorEvent) => this.handleError(errorEvent));
                this.handleOpen();
                resolve();
            });
            this.socket.addEventListener("error", handleError);
            this.socket.addEventListener("close", (event) => this.handleClose(event));
            this.socket.addEventListener("message", (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this.handleMessage(new Uint8Array(event.data));
                }
                else {
                    this.handleMessage(event.data);
                }
            });
        }).finally(() => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        });
    }

    private handleOpen(): void {
        this.logger.info("Connection open to " + this.socket?.url);
    }

    private handleError(event: Event): void {
        this.logger.error("Connection error", event);
        this._onError.dispatch(this, event);
    }

    private handleClose(event: CloseEvent): void {
        this.logger.info(`Connection closed (${this.socket?.url})`, event);
        this._onClose.dispatch(this, event);
    }

    private handleMessage(message: string | Uint8Array): void {
        if (typeof message !== "string") {
            if (message[0] === this.options.binaryRplPrefix) {
                this._onMessage.dispatch(this, message.subarray(1));
                return;
            }
            message = uint8ArrayToBinaryString(message);
        }
        if (AppLogger.enabledFor(AppLogger.DEBUG)) {
            this.logger.debug("Got message:", typeof message === "string" ? this.options.logFilter?.(message) ?? message : message);
        }
        let text = this.messageBuffer + message;
        this.messageBuffer = "";
        const lines = text.split(/\r?\n/);
        const lastLine = lines.pop();
        if (lastLine?.length) {
            this.messageBuffer = lastLine;
        }
        lines.filter(line => !!line).forEach(line => this._onMessage.dispatch(this, line));
    }

    async sendCommand(command: string, options: SendCommandOptions): Promise<IrcRawReply[]> {
        if (options.replyStartCode && !options.replyEndCode) {
            throw new Error("Invalid argument. Expected a reply end code, but got only a start code.");
        }
        const replies: IrcRawReply[] = [];
        return await this.sendRawCommand(command, (message, time, resolve, setTimeout) => {
            const matchesCode = (code: number | [number, (reply: IrcRawReply) => boolean], reply: IrcRawReply) => {
                if (typeof code === "number") {
                    return reply.code === code;
                }
                const [numericCode, check] = code;
                return reply.code === numericCode && check(reply);
            };
            let text: string;
            if (typeof message !== "string") {
                if (message[0] === this.options.binaryRplPrefix) {
                    return false;
                }
                text = uint8ArrayToBinaryString(message);
            }
            else {
                text = message;
            }
            if (options.replyRawText) {
                resolve(text.split(/\r?\n/).map(line => ({
                    raw: line,
                    time,
                })));
                return true;
            }
            return text.split(/\r?\n/).filter(line => !!line).some((line) => {
                const handleLine = (line: string): boolean => {
                    if (options.replyMatch) {
                        if (options.replyMatch.exec(line)) {
                            resolve([{ raw: line, time }]);
                            return true;
                        }
                        if (!options.replyCodes) {
                            return false;
                        }
                    }
                    if (!options.replyEndCode && !options.replyCodes) {
                        resolve([{ raw: line, time }]);
                        return true;
                    }
                    const [, codeString, ...params] = line.split(" ");
                    const code = parseInt(codeString, 10);
                    const reply: IrcRawReply = {
                        raw: line,
                        code,
                        params,
                        time,
                    };
                    if (options.replyEndCode) {
                        if (options.replyCodes && options.replyCodes.some((replyCode) => matchesCode(replyCode, reply))) {
                            resolve([reply]);
                            return true;
                        }
                        if (options.replyHeartbeatCodes && options.replyHeartbeatCodes.indexOf(code) !== -1) {
                            setTimeout(options.heartbeatTimeout);
                        }
                        if (code === options.replyStartCode ||
                            (options.replyBodyCodes && options.replyBodyCodes.indexOf(code) !== -1) ||
                            code === options.replyEndCode) {
                            replies.push(reply);
                        }
                        if (code === options.replyEndCode) {
                            resolve(replies);
                            return true;
                        }
                        return false;
                    }
                    if (options.replyCodes === undefined) {
                        throw new Error("List of replyCodes must be specified when not using start/end codes");
                    }
                    if (options.replyCodes.some((replyCode) => matchesCode(replyCode, reply))) {
                        resolve([reply]);
                        return true;
                    }
                    return false;
                };
                return handleLine(line);
            });
        }, options.timeout);
    }

    async sendBinCommand(command: Uint8Array, options: {
        replyCodes: number[];
        timeout?: number;
    }): Promise<Array<{
        code: number;
        data: Uint8Array;
        time: number;
    }>> {
        const replyPrefix = this.options.binaryRplPrefix;
        if (!replyPrefix) {
            throw new Error("Must configure binary message reply prefix to send binary commands");
        }
        const requestPrefix = this.options.binaryReqPrefix;
        if (!requestPrefix) {
            throw new Error("Must configure binary message request prefix to send binary commands");
        }
        if (command[0] !== requestPrefix) {
            throw new Error("Binary command must start with the magic prefix 0x" + requestPrefix.toString(16));
        }
        return await this.sendRawCommand(command, (message, time, resolve) => {
            if (typeof message === "string" || message[0] !== replyPrefix) {
                return false;
            }
            const code = message[1];
            if (options.replyCodes.indexOf(code) !== -1) {
                resolve([{
                    code,
                    data: message.slice(2),
                    time,
                }]);
                return true;
            }
            return false;
        }, options.timeout);
    }

    sendRawCommand<T>(command: string | Uint8Array, matcher: (message: string | Uint8Array, time: number, resolve: (replies: T[]) => void, setHeartbeatTimeout: (timeoutSeconds?: number) => void) => boolean, timeoutSeconds?: number): Promise<T[]> {
        return new Promise((resolve, reject) => {
            let completed = false;
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const setHeartbeatTimeout = (timeout?: number) => {
                clearTimeout(timeoutId);
                if (timeout !== undefined && Number.isFinite(timeout)) {
                    timeoutId = setTimeout(onTimeout, 1000 * (timeout ?? timeoutSeconds ?? this.timeout));
                }
            };
            const onResolve = (replies: T[]) => {
                clearTimeout(timeoutId);
                resolve(replies);
            };
            const onReject = (error: unknown) => {
                this.socket?.removeEventListener("message", onMessage);
                this.socket?.removeEventListener("close", onClose);
                clearTimeout(timeoutId);
                timeoutId = undefined;
                reject(error);
            };
            const onTimeout = () => {
                const commandName = typeof command === "string" ? this.options.logFilter?.(command) ?? command : "0x" + command[1].toString(16);
                onReject(new IrcConnection.NoReplyError("Timeout reached for command " + commandName));
            };
            const onClose = async () => {
                while (completed) {
                    await sleep(10);
                }
                if (!completed) {
                    onReject(new IrcConnection.SocketError("Connection was closed prematurely"));
                }
            };
            const onMessage = (event: MessageEvent) => {
                if (completed) {
                    return;
                }
                const time = Date.now();
                let handled = false;
                if (event.data instanceof ArrayBuffer) {
                    if (!completed) {
                        handled = matcher(new Uint8Array(event.data), time, onResolve, setHeartbeatTimeout);
                    }
                }
                else {
                    handled = matcher(event.data, time, onResolve, setHeartbeatTimeout);
                }
                if (handled) {
                    completed = true;
                    this.socket?.removeEventListener("message", onMessage);
                    this.socket?.removeEventListener("close", onClose);
                }
            };
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                timeoutId = setTimeout(onTimeout, 1000 * (timeoutSeconds ?? this.timeout));
                this.socket.addEventListener("message", onMessage);
                this.socket.addEventListener("close", onClose);
                try {
                    this.sendMessage(command);
                }
                catch (error) {
                    onReject(error);
                }
            }
            else {
                onReject(new IrcConnection.SocketError("Send command failed. Socket is not open." + (this.socket ? ` (readyState = ${this.socket.readyState})` : "")));
            }
        });
    }

    sendMessage(message: string | Uint8Array): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new IrcConnection.SocketError("Socket is not open" + (this.socket ? ` (readyState = ${this.socket.readyState})` : ""));
        }
        if (AppLogger.enabledFor(AppLogger.DEBUG)) {
            this.logger.debug("Sent message:", typeof message === "string" ? this.options.logFilter?.(message) ?? message : message);
        }
        let data: string | Uint8Array = message;
        if (typeof message === "string") {
            data = message + "\r\n";
        }
        if (this.options.mode === "binary" && typeof data === "string") {
            data = binaryStringToUint8Array(data);
        }
        this.socket.send(data);
    }

    async ping(timeoutSeconds: number): Promise<number> {
        const time = Date.now();
        const replies = await this.sendCommand("ping :" + time, {
            replyMatch: new RegExp("^:[^ ]+ PONG [^ :]+ :" + time, "i"),
            timeout: timeoutSeconds,
        });
        return replies[0].time - time;
    }

    close(): void {
        this.socket?.close();
    }

    isOpen(): boolean {
        return !!this.socket && this.socket.readyState === WebSocket.OPEN;
    }
}
