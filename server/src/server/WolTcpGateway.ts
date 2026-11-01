// A plain-TCP IRC gateway for the classic native WOL client.
//
// The browser reaches RA2Web over a WebSocket (`WS /wol`), but the native
// RA2/YR client only speaks the original Westwood Online line protocol over a
// TCP stream. The command handling is identical, so the gateway is a thin
// transport adapter: it frames the stream into lines, hands each one to
// `WolServer.handleMessage`, and writes the server's replies back. Accounts,
// sessions, channels, games, WDT and results are shared with the WebSocket
// lobby because it is the same `WolServer` instance.
//
// The native install points its Westwood Online server at WOL_TCP_HOST:
// WOL_TCP_PORT; no WOL line or port is added, so nothing else changes.

import { createServer, Server, Socket } from "node:net";
import { WolServer } from "./WolServer";
import { ServerUser } from "./ServerUser";
import { OPEN_STATE, SocketLike } from "./SocketLike";

export interface WolTcpGatewayOptions {
    host?: string;
    port?: number;
    /** A single line may not exceed this many bytes (WOL's own cap is 16 KiB). */
    maxLineBytes?: number;
    /** Drop a connection that sends nothing for this long; 0 disables it. */
    idleTimeoutMs?: number;
}

/** `SocketLike` over a net.Socket: UTF-8/ASCII text in, text out. */
class TcpSocket implements SocketLike {
    readyState = OPEN_STATE;

    constructor(private readonly socket: Socket) {
    }

    send(data: string | Uint8Array): void {
        if (this.readyState !== OPEN_STATE) return;
        this.socket.write(typeof data === "string" ? data : Buffer.from(data));
    }

    close(_code?: number, _reason?: string): void {
        if (this.readyState !== OPEN_STATE) return;
        this.readyState = 3;
        this.socket.end();
    }
}

export class WolTcpGateway {
    private server?: Server;
    private readonly sockets = new Set<Socket>();
    private readonly host: string;
    private readonly port: number;
    private readonly maxLineBytes: number;
    private readonly idleTimeoutMs: number;

    constructor(private readonly wol: WolServer, options: WolTcpGatewayOptions = {}) {
        this.host = options.host ?? "0.0.0.0";
        this.port = options.port ?? 6667;
        this.maxLineBytes = options.maxLineBytes ?? 16 * 1024;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
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
        if (this.idleTimeoutMs > 0) socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());

        const adapter = new TcpSocket(socket);
        const user: ServerUser = this.wol.handleOpen(adapter);
        let pending = "";

        socket.on("data", (chunk: Buffer) => {
            pending += chunk.toString("utf8");
            // Bound a client that never sends a newline.
            if (pending.length > this.maxLineBytes && !pending.includes("\n")) {
                this.wol.log.warn(`tcp wol: line too long from ${user.nick || "<anon>"}; closing`);
                socket.destroy();
                return;
            }
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const raw of lines) {
                const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
                if (line.length > this.maxLineBytes) {
                    this.wol.log.warn(`tcp wol: line too long from ${user.nick || "<anon>"}; closing`);
                    socket.destroy();
                    return;
                }
                this.wol.handleMessage(user, line);
                if (adapter.readyState !== OPEN_STATE || socket.destroyed) return;
            }
        });
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
            this.sockets.delete(socket);
            adapter.readyState = 3;
            this.wol.handleClose(user);
        });
    }
}
