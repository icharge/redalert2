import { Room, type Client, matchMaker } from "@colyseus/core";
import { Member, MatchmakingState } from "./MatchmakingState.ts";
import { signalingMessages } from "./SignalingMessages.ts";

const RECONNECT_GRACE_SECONDS = 10;

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
    // Tracks whether the label is still the auto-generated "<host>'s game"
    // default (vs. a name the creator explicitly typed), so a host transfer
    // knows whether it's safe to rename the room after them.
    private labelIsDefault = true;
    messages = {
        ...signalingMessages,
        "room-started"(this: MatchmakingRoom) {
            void this.lock();
        },
        "lock-room"(this: MatchmakingRoom, client: Client) {
            if (this.state.members.get(client.sessionId)?.peerId !== this.state.hostPeerId) {
                return;
            }
            this.state.locked = true;
            void this.lock();
        },
        "unlock-room"(this: MatchmakingRoom, client: Client) {
            if (this.state.members.get(client.sessionId)?.peerId !== this.state.hostPeerId) {
                return;
            }
            this.state.locked = false;
            void this.unlock();
        },
        "transfer-host"(this: MatchmakingRoom, client: Client, payload: { targetSessionId: string }) {
            const caller = this.state.members.get(client.sessionId);
            if (!caller || caller.peerId !== this.state.hostPeerId) {
                return;
            }
            const target = this.state.members.get(payload.targetSessionId);
            if (!target || payload.targetSessionId === client.sessionId) {
                return;
            }
            this.state.hostPeerId = target.peerId;
            if (this.labelIsDefault) {
                void this.setMetadata({ label: `${target.name}'s game` });
            }
        },
    };

    async onCreate(options: MatchmakingCreateOptions): Promise<void> {
        this.labelIsDefault = !options.label?.trim();
        const label = options.label?.trim() || `${options.name}'s game`;
        const existingRooms = await matchMaker.query({ name: "matchmaking", locked: false });
        const labelTaken = existingRooms.some((room) =>
            (room.metadata as MatchmakingRoomMetadata | undefined)?.label?.trim().toLowerCase() === label.toLowerCase());
        if (labelTaken) {
            throw new Error("Room name already in use");
        }

        this.state.roomId = this.roomId;
        this.state.hostPeerId = options.peerId;
        this.password = options.password?.trim() || undefined;
        this.metadata = {
            label,
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
        const trimmedName = options.name.trim().toLowerCase();
        for (const member of this.state.members.values()) {
            if (member.name.trim().toLowerCase() === trimmedName) {
                throw new Error("That player name is already taken in this room");
            }
        }
        return true;
    }

    onJoin(client: Client, options: MatchmakingJoinOptions): void {
        this.state.members.set(client.sessionId, new Member().assign({
            peerId: options.peerId,
            name: options.name,
        }));
    }

    /**
     * Fired on an involuntary disconnect (network drop, tab close without a
     * clean leave). Holds the member's seat open for a grace window instead
     * of removing them immediately — onLeave() below only runs afterward if
     * they don't reconnect in time (Colyseus calls it automatically once the
     * allowReconnection() deferred rejects).
     */
    onDrop(client: Client): void {
        void this.allowReconnection(client, RECONNECT_GRACE_SECONDS).catch(() => {
            // Reconnection window expired; onLeave() runs next and finalizes removal.
        });
    }

    /**
     * Fires for every final departure: a consented leave immediately, or an
     * onDrop() above whose reconnection grace window expired without the
     * client returning.
     *
     * If the departing member is still the host, the room closes for
     * everyone — whether they left on purpose or disconnected and never
     * came back. The only way to hand the room off intact is an explicit
     * "transfer-host" beforehand, which already moved state.hostPeerId away
     * from them (so this check no longer matches).
     */
    onLeave(client: Client): void {
        const member = this.state.members.get(client.sessionId);
        this.state.members.delete(client.sessionId);
        if (member && member.peerId === this.state.hostPeerId) {
            this.broadcast("host-lost");
            void this.disconnect();
        }
    }
}
