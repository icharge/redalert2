// The native WDT endpoint. Native RA2/YR read WDTHost/WDTPort from the WOL
// server-list entry and open a raw TCP connection; browsers never reach this
// listener because their faction click goes through WolChannel::RequestWDTState
// in the WOLAPI bridge.
//
// The request captured from the browser path is a cycle selector, not a WOL
// line. Until the native bytes are captured, the listener accepts the shapes
// the client can plausibly send:
//   * a tagged container with WREQ = 0 (current) or 1 (previous)
//   * the text `WDT CURRENT` / `WDT PREVIOUS` (CRLF or LF)
//   * one byte 0/1
// and always answers with the same state packet the bridge delivers.

import { createServer, Server, Socket } from "node:net";
import { decodeContainer, encodeNack, readU32 } from "./codec";
import { WdtService } from "./service";
import { WdtError } from "./types";

export interface WdtServerOptions {
    host?: string;
    port?: number;
    /** Bytes a request may carry before the connection is closed. */
    maxRequestBytes?: number;
    /** Milliseconds an idle client may hold the connection. */
    idleTimeoutMs?: number;
}

export class WdtTcpServer {
    private server?: Server;
    private readonly sockets = new Set<Socket>();
    private readonly host: string;
    private readonly port: number;
    private readonly maxRequestBytes: number;
    private readonly idleTimeoutMs: number;

    constructor(private readonly service: WdtService, options: WdtServerOptions = {}) {
        this.host = options.host ?? "127.0.0.1";
        this.port = options.port ?? 29090;
        this.maxRequestBytes = options.maxRequestBytes ?? 8192;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 5000;
    }

    get address(): { host: string; port: number } {
        const address = this.server?.address();
        if (address && typeof address === "object") return { host: address.address, port: address.port };
        return { host: this.host, port: this.port };
    }

    start(): Promise<{ host: string; port: number }> {
        return new Promise((resolve, reject) => {
            this.server = createServer(socket => this.accept(socket));
            this.server.once("error", reject);
            this.server.listen(this.port, this.host, () => {
                this.server?.off("error", reject);
                resolve(this.address);
            });
        });
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve());
        this.server = undefined;
    }

    private accept(socket: Socket): void {
        this.sockets.add(socket);
        socket.setNoDelay(true);
        socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
        let buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > this.maxRequestBytes) {
                socket.end(encodeNack("request too large"));
                return;
            }
            if (!this.complete(buffer)) return;
            socket.off("data", onData);
            this.reply(socket, buffer);
        };
        socket.on("data", onData);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => this.sockets.delete(socket));
    }

    /** A text request ends at a newline; a container ends at its own length. */
    private complete(buffer: Buffer): boolean {
        if (buffer.length === 0) return false;
        const newline = buffer.indexOf(0x0a);
        if (newline >= 0) return true;
        if (buffer.length >= 2) {
            const total = buffer.readUInt16BE(0);
            if (total >= 4 && total <= this.maxRequestBytes) return buffer.length >= total;
        }
        return buffer.length === 1 && buffer[0] <= 1;
    }

    private reply(socket: Socket, request: Buffer): void {
        let kind: "current" | "previous" = "current";
        try {
            if (request.length >= 4 && request.readUInt16BE(0) >= 4 && request.length >= request.readUInt16BE(0)) {
                const records = decodeContainer(request.subarray(0, request.readUInt16BE(0)));
                kind = readU32(records, "WREQ", 0) ? "previous" : "current";
            } else {
                const text = request.toString("ascii").trim().toUpperCase();
                if (text.includes("PREVIOUS") || text === "1") kind = "previous";
            }
            socket.end(this.service.packet(kind));
        } catch (error) {
            const reason = error instanceof WdtError ? error.message : "bad request";
            socket.end(encodeNack(reason));
        }
    }
}
