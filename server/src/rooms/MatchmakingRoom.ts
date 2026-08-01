import { Room, type Client } from "@colyseus/core";
import { Member, MatchmakingState } from "./MatchmakingState.ts";
import { signalingMessages } from "./SignalingMessages.ts";

export interface MatchmakingRoomMetadata {
    label: string;
    hostName: string;
    mapTitle: string;
    mapOfficial: boolean;
    gameModeLabel: string;
    maxSlots: number;
    passwordProtected: boolean;
}

export interface MatchmakingCreateOptions extends Partial<Omit<MatchmakingRoomMetadata, "passwordProtected">> {
    peerId: string;
    name: string;
    password?: string;
}

export interface MatchmakingJoinOptions {
    peerId: string;
    name: string;
    password?: string;
}

export class MatchmakingRoom extends Room<{ state: MatchmakingState; metadata: MatchmakingRoomMetadata }> {
    maxClients = 8;
    state = new MatchmakingState();
    private password?: string;
    messages = {
        ...signalingMessages,
        "room-started"(this: MatchmakingRoom) {
            void this.lock();
        },
    };

    onCreate(options: MatchmakingCreateOptions): void {
        this.state.roomId = this.roomId;
        this.state.hostPeerId = options.peerId;
        this.password = options.password?.trim() || undefined;
        this.metadata = {
            label: options.label ?? `${options.name}'s game`,
            hostName: options.name,
            mapTitle: options.mapTitle ?? "",
            mapOfficial: options.mapOfficial ?? true,
            gameModeLabel: options.gameModeLabel ?? "",
            maxSlots: options.maxSlots ?? this.maxClients,
            passwordProtected: Boolean(this.password),
        };
    }

    onAuth(_client: Client, options: MatchmakingJoinOptions): boolean {
        if (this.password && options.password !== this.password) {
            throw new Error("Incorrect room password");
        }
        return true;
    }

    onJoin(client: Client, options: MatchmakingJoinOptions): void {
        this.state.members.set(client.sessionId, new Member().assign({
            peerId: options.peerId,
            name: options.name,
        }));
    }

    onLeave(client: Client): void {
        this.state.members.delete(client.sessionId);
    }
}
