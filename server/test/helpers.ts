import { SocketLike } from "../src/server/SocketLike";

export class FakeSocket implements SocketLike {
    readyState = 1;
    sent: Array<string | Uint8Array> = [];

    send(data: string | Uint8Array): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
    }

    lines(): string[] {
        return this.sent
            .filter((data): data is string => typeof data === "string")
            .map(line => line.replace(/\r?\n$/, ""));
    }

    text(): string {
        return this.lines().join("\n");
    }
}

export function hasLine(socket: FakeSocket, predicate: (line: string) => boolean): boolean {
    return socket.lines().some(predicate);
}
