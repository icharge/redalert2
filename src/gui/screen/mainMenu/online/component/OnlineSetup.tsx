import React, { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { LobbyForm } from '@/gui/screen/mainMenu/lobby/component/LobbyForm';
import { LobbyType, PlayerStatus } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { RECIPIENT_ALL } from '@/network/gservConfig';
import { LanMeshSession, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import { LanRoomSession, LanRoomSnapshot } from '@/network/lan/LanRoomSession';
import { PregameController } from '@/gui/screen/mainMenu/lobby/PregameController';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';
import { OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomList } from '@/gui/screen/mainMenu/online/component/OnlineRoomList';

const MAX_PLAYER_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

interface Strings {
    get(key: string, ...args: any[]): string;
}

interface UiChatMessage {
    from?: string;
    to?: {
        type: number;
        name: string;
    };
    text: string;
    time?: Date;
}

interface OnlineSetupProps {
    strings: Strings;
    meshSession: LanMeshSession;
    roomSession: LanRoomSession;
    onlineSession: OnlineRoomSession;
    chatHistory: ChatHistory;
    pregameController: PregameController;
    resetNonce?: number;
    createRoomRequestId?: number;
    onSubmitCreateRoom: (details: { roomName: string; maxPlayers: number; password: string }) => Promise<void>;
    onStartGame: () => Promise<void>;
    onLeaveRoom: () => Promise<void>;
    onChangeMap: () => Promise<void>;
    onToggleReady: () => Promise<void>;
    onHostPregameChanged: () => void;
    onCommitName?: (name: string) => void;
    onJoinRoom: (roomId: string, password?: string) => Promise<void>;
}

const MAX_MESSAGES = 180;
function trimMessages(messages: UiChatMessage[]): UiChatMessage[] {
    if (messages.length <= MAX_MESSAGES) {
        return messages;
    }
    return messages.slice(messages.length - MAX_MESSAGES);
}

function createSystemMessage(text: string): UiChatMessage {
    return { text };
}

function createChatMessage(from: string, text: string, timestamp: number): UiChatMessage {
    return {
        from,
        to: {
            type: 0,
            name: RECIPIENT_ALL,
        },
        text,
        time: new Date(timestamp),
    };
}

function shouldSurfaceSystemLog(text: string): boolean {
    return /failed|error|unsupported|unable|timeout|interrupted|disconnected|closed|rejected|exception/i.test(text);
}

function describeRoomTone(roomSnapshot: LanRoomSnapshot): 'good' | 'warn' | 'bad' {
    if (roomSnapshot.canStart) {
        return 'good';
    }
    if (roomSnapshot.isRoomActive || roomSnapshot.mesh.isInRoom) {
        return 'warn';
    }
    return 'bad';
}

function describeCompactRoomState(roomSnapshot: LanRoomSnapshot): string {
    if (!roomSnapshot.isRoomActive) {
        return 'Connecting to other players';
    }
    if (roomSnapshot.canStart) {
        return 'Connection complete';
    }
    if (roomSnapshot.roomState && !roomSnapshot.roomState.gameOpts.mapOfficial) {
        return 'Waiting for map sync';
    }
    return 'Waiting for members to connect';
}

function describeMemberRoleTone(member: LanRoomSnapshot['members'][number]): 'good' | 'warn' | 'bad' {
    if (member.isHost || member.ready) {
        return 'good';
    }
    return member.isConnected ? 'warn' : 'bad';
}

function describeCustomMapTransfer(roomSnapshot: LanRoomSnapshot): { text: string; tone: 'good' | 'warn' | 'bad' } | undefined {
    if (!roomSnapshot.roomState || roomSnapshot.roomState.gameOpts.mapOfficial) {
        return undefined;
    }

    const failedMember = roomSnapshot.members.find((member) => member.mapTransfer.status === 'error');
    if (failedMember) {
        return { text: `Map sync failed: ${failedMember.name}`, tone: 'bad' };
    }

    const completedCount = roomSnapshot.members.filter((member) => member.mapTransfer.status === 'complete').length;
    if (completedCount >= roomSnapshot.members.length && roomSnapshot.members.length > 0) {
        return { text: 'Map sync complete', tone: 'good' };
    }

    return { text: `Map sync ${completedCount}/${roomSnapshot.members.length}`, tone: 'warn' };
}

export const OnlineSetup: React.FC<OnlineSetupProps> = ({
    meshSession,
    roomSession,
    onlineSession,
    chatHistory,
    pregameController,
    resetNonce = 0,
    createRoomRequestId = 0,
    onSubmitCreateRoom,
    onHostPregameChanged,
    onCommitName,
    onJoinRoom,
}) => {
    const [meshSnapshot, setMeshSnapshot] = useState<LanMeshSnapshot>(meshSession.getSnapshot());
    const [roomSnapshot, setRoomSnapshot] = useState<LanRoomSnapshot>(roomSession.getSnapshot());
    const [messages, setMessages] = useState<UiChatMessage[]>(() => chatHistory.getAll() as UiChatMessage[]);
    const [nameInput, setNameInput] = useState(meshSession.getSnapshot().self.name);
    const lastResetNonceRef = useRef(resetNonce);

    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createRoomName, setCreateRoomName] = useState('');
    const [createMaxPlayers, setCreateMaxPlayers] = useState(8);
    const [createPassword, setCreatePassword] = useState('');
    const lastCreateRequestRef = useRef(createRoomRequestId);

    const [joinTarget, setJoinTarget] = useState<OnlineRoomListing | null>(null);
    const [joinPassword, setJoinPassword] = useState('');
    const [joinBusy, setJoinBusy] = useState(false);
    const [joinError, setJoinError] = useState<string>();

    const supported = typeof RTCPeerConnection !== 'undefined';

    const appendMessage = (message: UiChatMessage) => {
        chatHistory.addChatMessage(message);
        startTransition(() => {
            setMessages((current) => trimMessages([...current, message]));
        });
    };

    const replaceMessages = (nextMessages: UiChatMessage[]) => {
        chatHistory.reset();
        nextMessages.forEach((message) => chatHistory.addChatMessage(message));
        startTransition(() => {
            setMessages(nextMessages);
        });
    };

    const appendSystemMessage = (text: string) => {
        appendMessage(createSystemMessage(text));
    };

    useEffect(() => {
        const handleMeshSnapshot = (nextSnapshot: LanMeshSnapshot) => {
            setMeshSnapshot(nextSnapshot);
            setNameInput((current) => (current === meshSnapshot.self.name ? nextSnapshot.self.name : current));
        };
        const handleRoomSnapshot = (nextSnapshot: LanRoomSnapshot) => {
            setRoomSnapshot(nextSnapshot);
        };
        const handleMeshLog = (entry: { text: string }) => {
            if (shouldSurfaceSystemLog(entry.text)) {
                appendSystemMessage(entry.text);
            }
        };
        const handleRoomLog = (entry: { text: string }) => {
            if (shouldSurfaceSystemLog(entry.text)) {
                appendSystemMessage(entry.text);
            }
        };
        const handleOnlineLog = (entry: { text: string }) => {
            appendSystemMessage(entry.text);
        };
        const handleChat = (entry: { from: { name: string }; text: string; timestamp: number }) => {
            appendMessage(createChatMessage(entry.from.name, entry.text, entry.timestamp));
        };

        meshSession.onSnapshotChange.subscribe(handleMeshSnapshot);
        roomSession.onSnapshotChange.subscribe(handleRoomSnapshot);
        meshSession.onLog.subscribe(handleMeshLog);
        roomSession.onLog.subscribe(handleRoomLog);
        onlineSession.onLog.subscribe(handleOnlineLog);
        meshSession.onChat.subscribe(handleChat);

        return () => {
            meshSession.onSnapshotChange.unsubscribe(handleMeshSnapshot);
            roomSession.onSnapshotChange.unsubscribe(handleRoomSnapshot);
            meshSession.onLog.unsubscribe(handleMeshLog);
            roomSession.onLog.unsubscribe(handleRoomLog);
            onlineSession.onLog.unsubscribe(handleOnlineLog);
            meshSession.onChat.unsubscribe(handleChat);
        };
    }, [chatHistory, meshSession, roomSession, onlineSession, meshSnapshot.self.name]);

    useEffect(() => {
        if (lastResetNonceRef.current === resetNonce) {
            return;
        }
        lastResetNonceRef.current = resetNonce;
        const nextSnapshot = meshSession.getSnapshot();
        setMeshSnapshot(nextSnapshot);
        setRoomSnapshot(roomSession.getSnapshot());
        setNameInput(nextSnapshot.self.name);
        replaceMessages([]);
    }, [meshSession, resetNonce, roomSession]);

    useEffect(() => {
        if (lastCreateRequestRef.current === createRoomRequestId) {
            return;
        }
        lastCreateRequestRef.current = createRoomRequestId;
        setCreateRoomName(`${meshSnapshot.self.name || 'Player'}'s room`);
        setCreateMaxPlayers(8);
        setCreatePassword('');
        setCreateDialogOpen(true);
    }, [createRoomRequestId, meshSnapshot.self.name]);

    const commitName = () => {
        meshSession.updateSelfName(nameInput);
        const nextSelf = meshSession.getSnapshot().self;
        setMeshSnapshot(meshSession.getSnapshot());
        setNameInput(nextSelf.name);
        onCommitName?.(nextSelf.name);
        if (roomSnapshot.isHost && roomSnapshot.roomState) {
            pregameController.updateSelfName(nextSelf.name);
            onHostPregameChanged();
        }
    };

    const handleSubmitCreate = async () => {
        setCreateBusy(true);
        try {
            commitName();
            await onSubmitCreateRoom({
                roomName: createRoomName,
                maxPlayers: createMaxPlayers,
                password: createPassword,
            });
            setCreateDialogOpen(false);
        }
        catch (error) {
            appendSystemMessage((error as Error).message);
        }
        finally {
            setCreateBusy(false);
        }
    };

    const handleRequestJoin = (room: OnlineRoomListing) => {
        setJoinTarget(room);
        setJoinPassword('');
        setJoinError(undefined);
    };

    const handleSubmitJoin = async () => {
        if (!joinTarget) {
            return;
        }
        setJoinBusy(true);
        setJoinError(undefined);
        try {
            commitName();
            await onJoinRoom(joinTarget.roomId, joinPassword.trim() || undefined);
            setJoinTarget(null);
        }
        catch (error) {
            setJoinError((error as Error).message);
        }
        finally {
            setJoinBusy(false);
        }
    };

    const handleSendMessage = async ({ value }: { value: string }) => {
        try {
            await meshSession.sendChat(value);
        }
        catch (error) {
            appendSystemMessage((error as Error).message);
        }
    };

    const submitChatMessage = (message: any) => {
        const value = typeof message === 'string' ? message : message?.value;
        if (typeof value === 'string' && value.trim()) {
            void handleSendMessage({ value });
        }
    };

    const waitingMode = roomSnapshot.isRoomActive || meshSnapshot.isInRoom;
    const selfAssignment = roomSnapshot.roomState?.humanAssignments.find((assignment) => assignment.peerId === meshSnapshot.self.id);
    const activeSlotIndex = selfAssignment?.slotIndex ?? 0;
    const selfMember = roomSnapshot.members.find((member) => member.isSelf);
    const customMapTransfer = describeCustomMapTransfer(roomSnapshot);
    const waitingStatusStrip = waitingMode ? (
        <div className="lan-room-status-strip">
            <div className="lan-status-chip">
                Room <strong>{meshSnapshot.roomId ?? '--'}</strong>
            </div>
            <div className="lan-status-chip">
                Members <strong data-lan-stat="members">{roomSnapshot.members.length || meshSnapshot.members.length}</strong>
                <span className="lan-status-divider">/</span>
                Direct <strong data-lan-stat="direct-peers">{meshSnapshot.directPeerCount}</strong>
            </div>
            <div className={`lan-status-chip tone-${describeRoomTone(roomSnapshot)}`}>
                {describeCompactRoomState(roomSnapshot)}
            </div>
            {selfMember ? (
                <div className={`lan-status-chip tone-${describeMemberRoleTone(selfMember)}`}>
                    {selfMember.isHost ? 'You are host' : selfMember.ready ? 'Ready' : 'Not ready'}
                </div>
            ) : null}
            {customMapTransfer ? (
                <div className={`lan-status-chip tone-${customMapTransfer.tone}`}>
                    {customMapTransfer.text}
                </div>
            ) : null}
        </div>
    ) : null;

    const formProps = useMemo(() => {
        if (!roomSnapshot.roomState) {
            return undefined;
        }

        pregameController.hydrate({
            gameOpts: roomSnapshot.roomState.gameOpts,
            slotsInfo: roomSnapshot.roomState.slotsInfo,
            currentMapFile: roomSession.getResolvedCustomMapFile(),
        });

        const baseProps = pregameController.createLobbyFormProps({
            lobbyType: roomSnapshot.isHost ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
            activeSlotIndex,
            messages,
            localUsername: meshSnapshot.self.name,
            channels: [RECIPIENT_ALL],
            chatHistory: chatHistory as any,
            onSendMessage: submitChatMessage,
            onStateChange: roomSnapshot.isHost ? onHostPregameChanged : undefined,
            decoratePlayerSlot: (playerSlot: any, _slotInfo: any, slotIndex: number) => {
                const assignment = roomSnapshot.roomState?.humanAssignments.find((candidate) => candidate.slotIndex === slotIndex);
                if (!assignment) {
                    return;
                }
                const member = roomSnapshot.members.find((candidate) => candidate.peerId === assignment.peerId);
                playerSlot.status = member?.isHost
                    ? PlayerStatus.Host
                    : member?.ready
                        ? PlayerStatus.Ready
                        : PlayerStatus.NotReady;
            },
        });

        if (!roomSnapshot.isHost && selfAssignment) {
            const requestOwnSlotConfig = (updater: (slot: any) => { countryId: number; colorId: number; startPos: number; teamId: number }) => {
                const slot = baseProps.playerSlots[selfAssignment.slotIndex];
                const next = updater(slot);
                void roomSession.requestSlotConfig(selfAssignment.slotIndex, next);
            };
            baseProps.onCountrySelect = (country: string) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos: slot.startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onColorSelect = (color: string) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(color),
                    startPos: slot.startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onStartPosSelect = (startPos: number) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onTeamSelect = (teamId: number) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos: slot.startPos,
                    teamId,
                }));
            };
        }

        return baseProps;
    }, [activeSlotIndex, chatHistory, meshSnapshot.self.id, meshSnapshot.self.name, messages, onHostPregameChanged, pregameController, roomSession, roomSnapshot, selfAssignment]);

    return (
        <div className="lobby-form lan-setup-form online-setup-form" data-online-view={waitingMode ? 'waiting' : 'entry'}>
            {!supported ? (
                <div className="lan-panel">
                    <h3>Environment Not Supported</h3>
                    <p>This browser has no WebRTC implementation available and cannot establish online connections on this page.</p>
                </div>
            ) : !waitingMode ? (
                <div className="lan-entry-layout">
                    <div className="lan-panel lan-entry-panel lan-entry-profile-panel">
                        <div className="lan-panel-header">
                            <h3>Player Info</h3>
                            <span>Set your name, then create a room or join one from the list.</span>
                        </div>
                        <div className="lan-entry-profile-grid">
                            <div className="lan-entry-profile-editor">
                                <label className="lan-input-label" htmlFor="online-self-name">
                                    Player Name
                                </label>
                                <input
                                    id="online-self-name"
                                    type="text"
                                    className="lan-text-input"
                                    maxLength={24}
                                    value={nameInput}
                                    data-online-input="self-name"
                                    onChange={(event) => setNameInput(event.target.value)}
                                    onBlur={commitName}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            commitName();
                                        }
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    <OnlineRoomList onlineSession={onlineSession} onJoin={handleRequestJoin} />
                </div>
            ) : (
                <div className="lan-waiting-main">
                    {formProps ? (
                        <div className="lan-room-form-shell lan-room-form-shell-compact">
                            <LobbyForm {...formProps} beforeChatContent={waitingStatusStrip} />
                        </div>
                    ) : (
                        <div className="lan-panel lan-room-loading-panel lan-room-loading-panel-compact">
                            Receiving room configuration...
                        </div>
                    )}
                </div>
            )}

            {createDialogOpen ? (
                <div className="lan-dialog-overlay" onClick={() => !createBusy && setCreateDialogOpen(false)}>
                    <div className="lan-dialog" onClick={(event) => event.stopPropagation()}>
                        <div className="lan-dialog-header">
                            <h3>Create Room</h3>
                            <button
                                type="button"
                                className="lan-dialog-close"
                                disabled={createBusy}
                                onClick={() => setCreateDialogOpen(false)}
                            >
                                ×
                            </button>
                        </div>
                        <div className="lan-dialog-body">
                            <label className="lan-input-label" htmlFor="online-create-room-name">
                                Room Name
                            </label>
                            <input
                                id="online-create-room-name"
                                type="text"
                                className="lan-text-input"
                                maxLength={40}
                                value={createRoomName}
                                onChange={(event) => setCreateRoomName(event.target.value)}
                                autoFocus
                            />

                            <label className="lan-input-label" htmlFor="online-create-max-players">
                                Max Players
                            </label>
                            <select
                                id="online-create-max-players"
                                className="lan-text-input"
                                value={createMaxPlayers}
                                onChange={(event) => setCreateMaxPlayers(Number(event.target.value))}
                            >
                                {MAX_PLAYER_OPTIONS.map((count) => (
                                    <option key={count} value={count}>{count}</option>
                                ))}
                            </select>
                            <div className="lan-entry-field-hint">Limited by the room's map — change later with Change Map.</div>

                            <label className="lan-input-label" htmlFor="online-create-password">
                                Password (optional)
                            </label>
                            <input
                                id="online-create-password"
                                type="password"
                                className="lan-text-input"
                                maxLength={32}
                                value={createPassword}
                                onChange={(event) => setCreatePassword(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        void handleSubmitCreate();
                                    }
                                }}
                            />

                            <div className="lan-actions">
                                <button
                                    type="button"
                                    className="dialog-button"
                                    disabled={createBusy || !createRoomName.trim()}
                                    onClick={() => void handleSubmitCreate()}
                                >
                                    {createBusy ? 'Creating...' : 'Create Room'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {joinTarget ? (
                <div className="lan-dialog-overlay" onClick={() => !joinBusy && setJoinTarget(null)}>
                    <div className="lan-dialog" onClick={(event) => event.stopPropagation()}>
                        <div className="lan-dialog-header">
                            <h3>Join {joinTarget.metadata.label || joinTarget.roomId}</h3>
                            <button
                                type="button"
                                className="lan-dialog-close"
                                disabled={joinBusy}
                                onClick={() => setJoinTarget(null)}
                            >
                                ×
                            </button>
                        </div>
                        <div className="lan-dialog-body">
                            <label className="lan-input-label" htmlFor="online-join-password">
                                {joinTarget.metadata.passwordProtected ? 'Password (required)' : 'Password (leave blank if none)'}
                            </label>
                            <input
                                id="online-join-password"
                                type="password"
                                className="lan-text-input"
                                value={joinPassword}
                                onChange={(event) => setJoinPassword(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        void handleSubmitJoin();
                                    }
                                }}
                                autoFocus
                            />
                            {joinError ? <div className="lan-entry-field-hint tone-bad">{joinError}</div> : null}
                            <div className="lan-actions">
                                <button
                                    type="button"
                                    className="dialog-button"
                                    disabled={joinBusy}
                                    onClick={() => void handleSubmitJoin()}
                                >
                                    {joinBusy ? 'Joining...' : 'Join'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
};
