import type { Room } from '@colyseus/sdk';
import { ColyseusClient } from '@/network/colyseus/ColyseusClient';
import { EventDispatcher } from '@/util/event';

export interface LobbyChatMessage {
    name: string;
    text: string;
    timestamp: number;
}

export interface LobbyMemberSnapshot {
    sessionId: string;
    name: string;
}

interface LobbyMemberState {
    name: string;
}

/**
 * Client-side bridge to the always-on global "lobby" Colyseus room: presence
 * (who's online, in or out of a match room) and plain broadcast chat. Kept
 * separate from OnlineRoomSession, which bridges a per-match room instead.
 */
export class LobbyChannelSession {
    private room?: Room<any>;
    private unbindHandlers: Array<() => void> = [];
    // Guards against concurrent join() calls (e.g. onEnter + onUnstack both
    // firing close together) racing two joinOrCreate() calls — without this,
    // whichever resolves last wins bindRoom() and silently orphans the
    // other's still-connected room with no message handlers left on it.
    private joinPromise?: Promise<void>;

    public readonly onChat = new EventDispatcher<this, LobbyChatMessage>();
    public readonly onMembersChanged = new EventDispatcher<this, LobbyMemberSnapshot[]>();
    public readonly onDisconnected = new EventDispatcher<this, void>();

    constructor(private readonly colyseusClient: ColyseusClient) {
    }

    isConnected(): boolean {
        return Boolean(this.room);
    }

    async join(name: string): Promise<void> {
        if (this.room) {
            return;
        }
        if (this.joinPromise) {
            return this.joinPromise;
        }
        this.joinPromise = (async () => {
            const room = await this.colyseusClient.getClient().joinOrCreate('lobby', { name });
            this.bindRoom(room);
        })();
        try {
            await this.joinPromise;
        }
        finally {
            this.joinPromise = undefined;
        }
    }

    leave(): void {
        this.unbindRoom();
        const room = this.room;
        this.room = undefined;
        void room?.leave();
    }

    sendChat(text: string): void {
        this.room?.send('chat', { text });
    }

    rename(name: string): void {
        this.room?.send('rename', { name });
    }

    getMembers(): LobbyMemberSnapshot[] {
        // room.state can briefly be unset right when joinOrCreate() resolves
        // — the room object is handed back before the first state patch has
        // necessarily been applied, and bindRoom() calls this immediately to
        // seed the initial snapshot. An uncaught throw here previously
        // aborted the rest of bindRoom() partway through, silently skipping
        // the chat onMessage registration entirely — tolerate the gap
        // instead of throwing.
        const members = this.room?.state?.members as Map<string, LobbyMemberState> | undefined;
        if (!members) {
            return [];
        }
        const snapshot: LobbyMemberSnapshot[] = [];
        members.forEach((member, sessionId) => {
            snapshot.push({ sessionId, name: member.name });
        });
        return snapshot;
    }

    private bindRoom(room: Room<any>): void {
        this.unbindRoom();
        this.room = room;

        const emitMembers = () => this.onMembersChanged.dispatch(this, this.getMembers());

        // The granular per-member callback-proxy `.listen()` API doesn't fire
        // for in-place field mutations on items handed back via onAdd (only
        // the raw decoded instance is passed, with no listen of its own, and
        // routing through the top-level proxy's listen(instance, prop, cb)
        // silently never invokes here either — confirmed live: the underlying
        // room.state.members value updates correctly on rename, but no
        // callback fires). onStateChange fires on every incoming patch
        // instead, so it catches joins, leaves, and renames uniformly.
        const handleStateChange = () => emitMembers();
        room.onStateChange(handleStateChange);
        emitMembers();

        const unbindChat = room.onMessage('chat', (message: LobbyChatMessage) => {
            this.onChat.dispatch(this, message);
        });

        room.onLeave(() => {
            this.room = undefined;
            this.onDisconnected.dispatch(this);
        });

        this.unbindHandlers = [
            unbindChat,
            () => room.onStateChange.remove(handleStateChange),
        ];
    }

    private unbindRoom(): void {
        this.unbindHandlers.forEach((unbind) => unbind());
        this.unbindHandlers = [];
    }
}
