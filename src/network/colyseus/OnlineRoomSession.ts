import { getStateCallbacks, type Room } from '@colyseus/sdk';
import { LanMeshSession } from '@/network/lan/LanMeshSession';
import { LanPeerIdentity } from '@/network/lan/LanQrPayload';
import { ColyseusClient, OnlineRoomListing, OnlineRoomMetadata } from '@/network/colyseus/ColyseusClient';
import { EventDispatcher } from '@/util/event';

export type OnlineRoomCreateOptions = Omit<OnlineRoomMetadata, 'hostName' | 'passwordProtected'> & { password?: string };

interface MemberState {
    peerId: string;
    name: string;
}

interface WebRtcOfferMessage {
    fromSessionId: string;
    fromPeerId: string;
    description: RTCSessionDescriptionInit;
}

interface WebRtcAnswerMessage {
    fromSessionId: string;
    fromPeerId: string;
    description: RTCSessionDescriptionInit;
}

export interface OnlineLogEntry {
    level: 'info' | 'warn' | 'error';
    text: string;
}

interface MatchmakingStateLike {
    locked: boolean;
}

/**
 * Bridges a Colyseus room (discovery, membership, WebRTC signaling relay)
 * to a LanMeshSession, which owns the actual peer-to-peer mesh. Colyseus
 * never sees game/lobby state: once every member has a direct link, all
 * lobby logic runs through the unmodified LanRoomSession over the mesh,
 * exactly as it does for LAN play.
 */
export class OnlineRoomSession {
    private room?: Room<any>;
    private unbindHandlers: Array<() => void> = [];

    public readonly onLog = new EventDispatcher<this, OnlineLogEntry>();
    public readonly onDisconnected = new EventDispatcher<this, void>();
    public readonly onLockChanged = new EventDispatcher<this, boolean>();

    constructor(
        private readonly meshSession: LanMeshSession,
        private readonly colyseusClient: ColyseusClient
    ) {
    }

    isConnected(): boolean {
        return Boolean(this.room);
    }

    async listRooms(): Promise<OnlineRoomListing[]> {
        return this.colyseusClient.listRooms();
    }

    async createRoom(options: OnlineRoomCreateOptions): Promise<void> {
        await this.applyServerIceServers();
        const self = this.meshSession.getSelf();
        const room = await this.colyseusClient.getClient().create('matchmaking', {
            peerId: self.id,
            name: self.name,
            ...options,
        });
        this.bindRoom(room);
    }

    async joinRoom(roomId: string, password?: string): Promise<void> {
        await this.applyServerIceServers();
        const self = this.meshSession.getSelf();
        const room = await this.colyseusClient.getClient().joinById(roomId, {
            peerId: self.id,
            name: self.name,
            password,
        });
        this.bindRoom(room);
    }

    private async applyServerIceServers(): Promise<void> {
        try {
            const iceServers = await this.colyseusClient.getIceServers();
            this.meshSession.setIceServers(iceServers);
        }
        catch (error) {
            this.log('warn', `Failed to fetch ICE server config, using defaults: ${(error as Error).message}`);
        }
    }

    /**
     * Tells the server this room's match has started, so it drops out of
     * the browsable list. Best-effort: does nothing if not connected.
     */
    notifyGameStarted(): void {
        this.room?.send('room-started');
    }

    setLocked(locked: boolean): void {
        this.room?.send(locked ? 'lock-room' : 'unlock-room');
    }

    isLocked(): boolean {
        return (this.room?.state as MatchmakingStateLike | undefined)?.locked ?? false;
    }

    /**
     * Hands room ownership to another currently-connected member, identified
     * by peerId (resolved to their Colyseus sessionId server-side needs it,
     * so we look that up here rather than pushing session-id bookkeeping
     * onto callers).
     */
    transferHost(targetPeerId: string): void {
        if (!this.room) {
            return;
        }
        const members = this.room.state.members as Map<string, MemberState>;
        for (const [sessionId, member] of members) {
            if (member.peerId === targetPeerId) {
                this.room.send('transfer-host', { targetSessionId: sessionId });
                return;
            }
        }
    }

    leaveRoom(): void {
        this.unbindRoom();
        const room = this.room;
        this.room = undefined;
        void room?.leave();
    }

    private bindRoom(room: Room<any>): void {
        this.unbindRoom();
        this.room = room;
        this.meshSession.bindExternalRoom(room.roomId);

        const stateProxy = getStateCallbacks(room)(room.state);

        stateProxy.listen('locked', (locked: boolean) => {
            this.onLockChanged.dispatch(this, locked);
        });

        // Deterministic tie-break so exactly one side of each pair offers.
        // Reused both for a peer's initial join and for re-establishing a
        // direct link after this client reconnects (see room.onReconnect
        // below) — a Colyseus-level reconnect doesn't restore the
        // independent WebRTC layer, so that has to be re-negotiated too.
        const offerToPeerIfNeeded = (peer: LanPeerIdentity, sessionId: string) => {
            this.meshSession.registerMember(peer);
            if (room.sessionId < sessionId) {
                this.meshSession.createOfferForPeer(peer)
                    .then((description) => room.send('webrtc-offer', { targetSessionId: sessionId, description }))
                    .catch((error) => this.log('warn', `Failed to create offer for ${peer.name}: ${(error as Error).message}`));
            }
        };

        stateProxy.members.onAdd((member: MemberState, sessionId: string) => {
            if (sessionId === room.sessionId) {
                return;
            }
            offerToPeerIfNeeded({ id: member.peerId, name: member.name }, sessionId);
        });

        stateProxy.members.onRemove((member: MemberState) => {
            this.meshSession.unregisterMember(member.peerId, 'left');
        });

        const unbindOffer = room.onMessage('webrtc-offer', (message: WebRtcOfferMessage) => {
            const memberState = (room.state.members as Map<string, MemberState>).get(message.fromSessionId);
            const peer: LanPeerIdentity = { id: message.fromPeerId, name: memberState?.name ?? message.fromPeerId };
            this.meshSession.acceptRemoteOffer(peer, message.description)
                .then((description) => room.send('webrtc-answer', { targetSessionId: message.fromSessionId, description }))
                .catch((error) => this.log('warn', `Failed to accept offer from ${peer.name}: ${(error as Error).message}`));
        });

        const unbindAnswer = room.onMessage('webrtc-answer', (message: WebRtcAnswerMessage) => {
            this.meshSession.acceptRemoteAnswer(message.fromPeerId, message.description)
                .catch((error) => this.log('warn', `Failed to accept answer: ${(error as Error).message}`));
        });

        const unbindHostLost = room.onMessage('host-lost', () => {
            this.log('warn', 'The host disconnected and did not return in time; the room has closed.');
        });

        room.onReconnect(() => {
            this.log('info', 'Reconnected to the room; re-establishing direct links...');
            const connectedPeerIds = new Set(
                this.meshSession.getSnapshot().members
                    .filter((snapshotMember) => snapshotMember.status === 'connected')
                    .map((snapshotMember) => snapshotMember.id)
            );
            (room.state.members as Map<string, MemberState>).forEach((member, sessionId) => {
                if (sessionId === room.sessionId || connectedPeerIds.has(member.peerId)) {
                    return;
                }
                offerToPeerIfNeeded({ id: member.peerId, name: member.name }, sessionId);
            });
        });

        room.onLeave(() => {
            this.room = undefined;
            this.onDisconnected.dispatch(this);
        });

        this.unbindHandlers = [unbindOffer, unbindAnswer, unbindHostLost];
    }

    private unbindRoom(): void {
        this.unbindHandlers.forEach((unbind) => unbind());
        this.unbindHandlers = [];
    }

    private log(level: OnlineLogEntry['level'], text: string): void {
        this.onLog.dispatch(this, { level, text });
    }
}
