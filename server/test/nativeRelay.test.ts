import { describe, expect, test } from "bun:test";
import { GservManager } from "../src/gserv/GservManager";
import { NativeRelay, nativeVirtualIp, formatIp } from "../src/gserv/NativeRelay";
import { makeLogger } from "../src/logger";
import { FakeSocket } from "./helpers";

function setup(players: string[]) {
    const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const instance = manager.create(players, "ws://gserv");
    const relay = new NativeRelay(manager, makeLogger("error", "test"));
    return { manager, instance, relay };
}

function connect(relay: NativeRelay, ticket: string) {
    const socket = new FakeSocket();
    const client = relay.handleOpen(socket);
    relay.handleMessage(client, `ticket ${ticket}`);
    return { socket, client };
}

function datagram(ip: number, srcPort: number, dstPort: number, payload: number[]): Uint8Array {
    return Uint8Array.from([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255,
        srcPort >> 8, srcPort & 255, dstPort >> 8, dstPort & 255, ...payload]);
}

describe("NativeRelay", () => {
    test("keeps an active native instance and retains it for late results after the last departure", () => {
        const { manager, instance, relay } = setup(["alice", "bob"]);
        const a = connect(relay, instance.tickets.get("alice")!);
        const b = connect(relay, instance.tickets.get("bob")!);
        expect(instance.started).toBe(true);
        manager.sweepExpired(1, 60, instance.timestamp + 100);
        expect(manager.get(instance.gameId)).toBe(instance);
        relay.handleClose(a.client);
        expect(instance.endedAt).toBeUndefined();
        relay.handleClose(b.client);
        expect(instance.endedAt).toBeNumber();
        expect(manager.get(instance.gameId)).toBe(instance);
        relay.dispose();
    });

    test("virtual IPs are stable, case-insensitive and avoid .0 / .255", () => {
        expect(nativeVirtualIp("Alice")).toBe(nativeVirtualIp("alice"));
        expect(formatIp(nativeVirtualIp("alice")).startsWith("10.")).toBe(true);
        for (const nick of ["a", "b", "c", "woltst1", "woltst2", "x".repeat(9)]) {
            const low = nativeVirtualIp(nick) & 255;
            expect(low !== 0 && low !== 255).toBe(true);
        }
    });

    test("a valid ticket is accepted with the player's virtual IP", () => {
        const { instance, relay } = setup(["alice", "bob"]);
        const { socket } = connect(relay, instance.tickets.get("alice")!);
        expect(socket.sent[0]).toBe(`ok ${formatIp(nativeVirtualIp("alice"))}`);
    });

    test("a bad ticket is rejected and closed", () => {
        const { relay } = setup(["alice"]);
        const { socket } = connect(relay, "nope");
        expect(String(socket.sent[0])).toContain("error");
        expect(socket.readyState).toBe(3);
    });

    test("a socket that never presents a ticket is closed", async () => {
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const relay = new NativeRelay(manager, makeLogger("error", "test"), 20);
        const socket = new FakeSocket();
        relay.handleOpen(socket);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(String(socket.sent[0])).toContain("ticket timeout");
        expect(socket.readyState).toBe(3);
    });

    test("datagrams reach only the addressed peer, with the sender's IP", () => {
        const { instance, relay } = setup(["alice", "bob", "carol"]);
        const a = connect(relay, instance.tickets.get("alice")!);
        const b = connect(relay, instance.tickets.get("bob")!);
        const c = connect(relay, instance.tickets.get("carol")!);
        relay.handleMessage(a.client, datagram(nativeVirtualIp("bob"), 1234, 1234, [1, 2, 3]));
        const got = b.socket.sent.at(-1) as Uint8Array;
        expect(Array.from(got.slice(0, 4))).toEqual([nativeVirtualIp("alice") >>> 24, (nativeVirtualIp("alice") >>> 16) & 255, (nativeVirtualIp("alice") >>> 8) & 255, nativeVirtualIp("alice") & 255]);
        expect(Array.from(got.slice(4))).toEqual([4, 210, 4, 210, 1, 2, 3]);
        expect(c.socket.sent.length).toBe(1);
        expect(a.socket.sent.length).toBe(1);
    });

    test("broadcast reaches everyone but the sender; unknown and pre-login traffic is dropped", () => {
        const { instance, relay } = setup(["alice", "bob", "carol"]);
        const early = new FakeSocket();
        relay.handleMessage(relay.handleOpen(early), datagram(1, 1, 1, [9]));
        const a = connect(relay, instance.tickets.get("alice")!);
        const b = connect(relay, instance.tickets.get("bob")!);
        const c = connect(relay, instance.tickets.get("carol")!);
        relay.handleMessage(a.client, datagram(0xffffffff, 1380, 1380, [7]));
        expect(b.socket.sent.length).toBe(2);
        expect(c.socket.sent.length).toBe(2);
        expect(a.socket.sent.length).toBe(1);
        relay.handleMessage(a.client, datagram(0x0a000001, 1, 1, [7]));
        expect(b.socket.sent.length).toBe(2);
    });

    test("a player is not addressable after leaving", () => {
        const { instance, relay } = setup(["alice", "bob"]);
        const a = connect(relay, instance.tickets.get("alice")!);
        const b = connect(relay, instance.tickets.get("bob")!);
        relay.handleClose(b.client);
        relay.handleMessage(a.client, datagram(nativeVirtualIp("bob"), 1, 1, [1]));
        expect(b.socket.sent.length).toBe(1);
    });
});
