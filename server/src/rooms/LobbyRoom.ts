import { Room, type Client } from "@colyseus/core";
import { LobbyMember, LobbyState } from "./LobbyState.ts";

export interface LobbyJoinOptions {
    name: string;
}

const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 200;

function sanitizeName(name: string): string {
    return name.trim().slice(0, MAX_NAME_LENGTH) || "Guest";
}

export class LobbyRoom extends Room<{ state: LobbyState; metadata: never }> {
    // Soft safety cap for the always-on global channel, not a real capacity constraint.
    maxClients = 500;
    state = new LobbyState();
    // Always-on singleton joined via joinOrCreate; must not tear down at zero members.
    autoDispose = false;

    messages = {
        "chat"(this: LobbyRoom, client: Client, payload: { text?: string }) {
            const text = payload?.text?.trim().slice(0, MAX_CHAT_LENGTH);
            if (!text) {
                return;
            }
            const member = this.state.members.get(client.sessionId);
            if (!member) {
                return;
            }
            this.broadcast("chat", { name: member.name, text, timestamp: Date.now() });
        },
        "rename"(this: LobbyRoom, client: Client, payload: { name?: string }) {
            const member = this.state.members.get(client.sessionId);
            if (!member || typeof payload?.name !== "string") {
                return;
            }
            member.name = sanitizeName(payload.name);
        },
    };

    onJoin(client: Client, options: LobbyJoinOptions): void {
        this.state.members.set(client.sessionId, new LobbyMember().assign({
            name: sanitizeName(options?.name ?? ""),
        }));
    }

    onLeave(client: Client): void {
        this.state.members.delete(client.sessionId);
    }
}
