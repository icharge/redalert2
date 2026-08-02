import React, { startTransition, useEffect, useMemo, useState } from 'react';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { LobbyForm } from '@/gui/screen/mainMenu/lobby/component/LobbyForm';
import { LobbyType, PlayerStatus } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { RECIPIENT_ALL } from '@/network/gservConfig';
import { LanMeshSession, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import { LanRoomSession, LanRoomSnapshot } from '@/network/lan/LanRoomSession';
import { PregameController } from '@/gui/screen/mainMenu/lobby/PregameController';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';

interface UiChatMessage {
    from?: string;
    to?: {
        type: number;
        name: string;
    };
    text: string;
    time?: Date;
}

interface OnlineRoomProps {
    meshSession: LanMeshSession;
    roomSession: LanRoomSession;
    onlineSession: OnlineRoomSession;
    pregameController: PregameController;
    chatHistory: ChatHistory;
    locked: boolean;
    onHostPregameChanged: () => void;
    onTransferHost: (slotIndex: number) => void;
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

function formatLogText(level: 'info' | 'warn' | 'error', text: string): string {
    return level === 'info' ? text : `[${level}] ${text}`;
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

export const OnlineRoom: React.FC<OnlineRoomProps> = ({
    meshSession,
    roomSession,
    onlineSession,
    pregameController,
    chatHistory,
    locked,
    onHostPregameChanged,
    onTransferHost,
}) => {
    const [meshSnapshot, setMeshSnapshot] = useState<LanMeshSnapshot>(meshSession.getSnapshot());
    const [roomSnapshot, setRoomSnapshot] = useState<LanRoomSnapshot>(roomSession.getSnapshot());
    const [messages, setMessages] = useState<UiChatMessage[]>(() => chatHistory.getAll() as UiChatMessage[]);
    const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | undefined>(undefined);

    useEffect(() => {
        const endsAt = roomSnapshot.countdown?.endsAt;
        if (!endsAt) {
            setCountdownSecondsLeft(undefined);
            return;
        }
        const tick = () => setCountdownSecondsLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
        tick();
        const intervalId = window.setInterval(tick, 250);
        return () => window.clearInterval(intervalId);
    }, [roomSnapshot.countdown?.endsAt]);

    const appendMessage = (message: UiChatMessage) => {
        chatHistory.addChatMessage(message);
        startTransition(() => {
            setMessages((current) => trimMessages([...current, message]));
        });
    };

    const appendSystemMessage = (text: string) => {
        appendMessage(createSystemMessage(text));
    };

    useEffect(() => {
        const handleMeshSnapshot = (nextSnapshot: LanMeshSnapshot) => setMeshSnapshot(nextSnapshot);
        const handleRoomSnapshot = (nextSnapshot: LanRoomSnapshot) => setRoomSnapshot(nextSnapshot);
        const handleMeshLog = (entry: { level: 'info' | 'warn' | 'error'; text: string }) => {
            appendSystemMessage(formatLogText(entry.level, entry.text));
        };
        const handleRoomLog = (entry: { level: 'info' | 'warn' | 'error'; text: string }) => {
            appendSystemMessage(formatLogText(entry.level, entry.text));
        };
        const handleOnlineLog = (entry: { level: 'info' | 'warn' | 'error'; text: string }) => {
            appendSystemMessage(formatLogText(entry.level, entry.text));
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
    }, [chatHistory, meshSession, roomSession, onlineSession]);

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

    const selfAssignment = roomSnapshot.roomState?.humanAssignments.find((assignment) => assignment.peerId === meshSnapshot.self.id);
    const activeSlotIndex = selfAssignment?.slotIndex ?? 0;
    const selfMember = roomSnapshot.members.find((member) => member.isSelf);
    const reconnectingMembers = roomSnapshot.members.filter((member) => member.isReconnecting);
    const customMapTransfer = describeCustomMapTransfer(roomSnapshot);
    const statusStrip = (
        <div className="lan-room-status-strip">
            <div className="lan-status-chip">
                Room <strong>{meshSnapshot.roomId ?? '--'}</strong>
            </div>
            {locked ? (
                <div className="lan-status-chip tone-warn">
                    Room locked
                </div>
            ) : null}
            <div className="lan-status-chip">
                Members <strong data-lan-stat="members">{roomSnapshot.members.length || meshSnapshot.members.length}</strong>
                <span className="lan-status-divider">/</span>
                Direct <strong data-lan-stat="direct-peers">{meshSnapshot.directPeerCount}</strong>
            </div>
            <div className={`lan-status-chip tone-${describeRoomTone(roomSnapshot)}`}>
                {describeCompactRoomState(roomSnapshot)}
            </div>
            {reconnectingMembers.length > 0 ? (
                <div className="lan-status-chip tone-warn">
                    Reconnecting: {reconnectingMembers.map((member) => member.name).join(', ')}
                </div>
            ) : null}
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
            {roomSnapshot.countdown && countdownSecondsLeft !== undefined ? (
                <div className="lan-status-chip tone-warn">
                    Starting in {countdownSecondsLeft}…
                </div>
            ) : null}
        </div>
    );

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
                playerSlot.ping = member?.ping;
            },
        });

        baseProps.onTransferHost = roomSnapshot.isHost ? onTransferHost : undefined;

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
    }, [activeSlotIndex, chatHistory, meshSnapshot.self.id, meshSnapshot.self.name, messages, onHostPregameChanged, onTransferHost, pregameController, roomSession, roomSnapshot, selfAssignment]);

    return (
        <div className="lobby-form lan-setup-form online-setup-form" data-online-view="waiting">
            <div className="lan-waiting-main">
                {formProps ? (
                    <div className="lan-room-form-shell lan-room-form-shell-compact">
                        <LobbyForm {...formProps} beforeChatContent={statusStrip} />
                    </div>
                ) : (
                    <div className="lan-panel lan-room-loading-panel lan-room-loading-panel-compact">
                        Receiving room configuration...
                    </div>
                )}
            </div>
        </div>
    );
};
