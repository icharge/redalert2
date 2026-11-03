import { GservManager } from "./GservManager";
import { SocketLike, OPEN_STATE } from "../server/SocketLike";
import { Logger } from "../logger";

/**
 * Datagram relay for the recompiled native Red Alert 2 / Yuri's Revenge
 * clients, which play with their own UDP netcode instead of RA2Web's lockstep.
 *
 * A browser cannot send UDP, so the page's HLE Winsock hands each game
 * datagram to this relay over one WebSocket per player and the relay delivers
 * it to the addressed player. Players are authenticated by the same gserv
 * ticket that STARTG hands out, and are addressed by a virtual IPv4 address
 * derived from their nickname (the bridge gives the game the same addresses in
 * the WOLAPI user list), so no address allocation has to be exchanged.
 *
 * Page to relay (binary): dstIp[4] srcPort[2] dstPort[2] payload
 * Relay to page (binary): srcIp[4] srcPort[2] dstPort[2] payload
 * Ports are network order. Text frames: "ticket <ticket>" is answered with
 * "ok <ip>" or "error <reason>"; nothing else is accepted.
 */

export const NATIVE_RELAY_MAX_PACKET = 1500;
/** How long a socket may stay connected without presenting a valid ticket. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** FNV-1a over the lower-cased nick; the TypeScript twin of wolapi.c's virtual_ip(). */
export function nativeVirtualIp(nick: string): number {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(nick.toLowerCase())) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let low = hash & 0xff;
    if (low === 0 || low === 0xff) low ^= 1;
    return ((10 << 24) | (((hash >>> 16) & 0xff) << 16) | (((hash >>> 8) & 0xff) << 8) | low) >>> 0;
}

export function formatIp(ip: number): string {
    return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");
}

export interface NativeRelayClient {
    socket: SocketLike;
    nick: string;
    ip: number;
    gameId?: string;
    handshakeTimer?: ReturnType<typeof setTimeout>;
    /** Debug: datagrams seen from this client, for start-up diagnosis. */
    packets?: number;
}

export class NativeRelay {
    private clients = new Map<SocketLike, NativeRelayClient>();
    /** gameId -> virtual IP -> client */
    private games = new Map<string, Map<number, NativeRelayClient>>();

    constructor(
        private manager: GservManager,
        private log: Logger,
        private handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
        /** Test-only: hold every datagram this long before delivery, to simulate a slow relay. */
        private delayMs = 0,
    ) {
        if (delayMs > 0) {
            log.warn(`native relay: delaying every datagram by ${delayMs} ms (test setting)`);
        }
    }

    handleOpen(socket: SocketLike): NativeRelayClient {
        const client: NativeRelayClient = { socket, nick: "", ip: 0 };
        this.clients.set(socket, client);
        client.handshakeTimer = setTimeout(() => {
            if (!client.gameId) this.reject(client, "ticket timeout");
        }, this.handshakeTimeoutMs);
        return client;
    }

    handleMessage(client: NativeRelayClient, message: string | Uint8Array): void {
        if (typeof message === "string") {
            this.handleText(client, message.trim());
            return;
        }
        this.handleDatagram(client, message);
    }

    handleClose(client: NativeRelayClient): void {
        clearTimeout(client.handshakeTimer);
        this.clients.delete(client.socket);
        if (!client.gameId) return;
        const peers = this.games.get(client.gameId);
        if (peers?.get(client.ip) === client) peers.delete(client.ip);
        if (peers && peers.size === 0) {
            this.games.delete(client.gameId);
            this.manager.retireInstance(client.gameId);
        }
        this.log.info(`native relay: ${client.nick} left ${client.gameId}`);
    }

    private reject(client: NativeRelayClient, reason: string): void {
        client.socket.send(`error ${reason}`);
        client.socket.close(4001, reason);
    }

    private handleText(client: NativeRelayClient, text: string): void {
        const parts = text.split(/\s+/);
        if (parts[0]?.toLowerCase() !== "ticket" || !parts[1] || client.gameId) {
            this.reject(client, "expected ticket");
            return;
        }
        const info = this.manager.validateTicket(parts[1]);
        const instance = info && this.manager.get(info.gameId);
        if (!info || !instance) {
            this.reject(client, "invalid ticket");
            return;
        }
        const ip = nativeVirtualIp(info.nick);
        let peers = this.games.get(info.gameId);
        if (!peers) {
            peers = new Map();
            this.games.set(info.gameId, peers);
        }
        // Two roster nicks hashing to one address would be indistinguishable to
        // the game; fail loudly instead of delivering to the wrong player.
        for (const nick of instance.players) {
            if (nick !== info.nick && nativeVirtualIp(nick) === ip) {
                this.reject(client, "address collision");
                return;
            }
        }
        const previous = peers.get(ip);
        if (previous && previous !== client) previous.socket.close(4002, "replaced");
        client.nick = info.nick;
        client.ip = ip;
        client.gameId = info.gameId;
        clearTimeout(client.handshakeTimer);
        peers.set(ip, client);
        if (peers.size >= instance.players.length) instance.started = true;
        this.log.info(`native relay: ${client.nick} joined ${client.gameId} as ${formatIp(ip)}`);
        client.socket.send(`ok ${formatIp(ip)}`);
    }

    private handleDatagram(client: NativeRelayClient, packet: Uint8Array): void {
        if (!client.gameId || packet.length < 8 || packet.length > 8 + NATIVE_RELAY_MAX_PACKET) return;
        const dst = ((packet[0] << 24) | (packet[1] << 16) | (packet[2] << 8) | packet[3]) >>> 0;
        const count = (client.packets = (client.packets ?? 0) + 1);
        if (count <= 24) {
            this.log.debug(`native relay: ${client.nick} packet ${count} len=${packet.length} dst=${formatIp(dst)}`);
        }
        const peers = this.games.get(client.gameId);
        if (!peers) return;
        const targets = dst === 0xffffffff
            ? [...peers.values()].filter(peer => peer !== client)
            : [peers.get(dst)].filter((peer): peer is NativeRelayClient => !!peer && peer !== client);
        if (targets.length === 0) {
            if (count <= 24) this.log.debug(`native relay: ${client.nick} packet ${count} has no target`);
            return;
        }
        const out = new Uint8Array(packet);
        out[0] = client.ip >>> 24; out[1] = (client.ip >>> 16) & 255; out[2] = (client.ip >>> 8) & 255; out[3] = client.ip & 255;
        const deliver = () => {
            for (const peer of targets) {
                if (peer.socket.readyState !== OPEN_STATE) continue;
                peer.socket.send(out);
            }
        };
        if (this.delayMs > 0) setTimeout(deliver, this.delayMs);
        else deliver();
    }

    dispose(): void {
        for (const client of this.clients.values()) {
            clearTimeout(client.handshakeTimer);
            client.socket.close(1001, "shutdown");
        }
        this.clients.clear();
        this.games.clear();
    }
}
