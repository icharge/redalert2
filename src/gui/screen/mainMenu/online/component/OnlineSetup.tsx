import React, { useEffect, useRef, useState } from 'react';
import { LanMeshSession, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';
import { OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { LobbyChannelSession, LobbyChatMessage } from '@/network/colyseus/LobbyChannelSession';
import { OnlineRoomList } from '@/gui/screen/mainMenu/online/component/OnlineRoomList';
import { LobbyPlayerList } from '@/gui/screen/mainMenu/online/component/LobbyPlayerList';
import { Chat } from '@/gui/component/Chat';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { RECIPIENT_ALL } from '@/network/gservConfig';

interface UiLobbyChatMessage {
    from: string;
    to: { type: number; name: string };
    text: string;
    time: Date;
}

const MAX_LOBBY_MESSAGES = 180;
function trimLobbyMessages(messages: UiLobbyChatMessage[]): UiLobbyChatMessage[] {
    if (messages.length <= MAX_LOBBY_MESSAGES) {
        return messages;
    }
    return messages.slice(messages.length - MAX_LOBBY_MESSAGES);
}

function toUiLobbyMessage(entry: LobbyChatMessage): UiLobbyChatMessage {
    return {
        from: entry.name,
        to: { type: 0, name: RECIPIENT_ALL },
        text: entry.text,
        time: new Date(entry.timestamp),
    };
}

// Stable reference: ChatInput defaults an unset `channels` prop to a fresh
// `[]` on every render, and an internal effect keyed on that array's
// identity — passing a literal here (or omitting the prop) causes an
// infinite render loop.
const LOBBY_CHAT_CHANNELS = [RECIPIENT_ALL];

interface OnlineSetupProps {
    meshSession: LanMeshSession;
    onlineSession: OnlineRoomSession;
    lobbySession: LobbyChannelSession;
    lobbyChatHistory: ChatHistory;
    resetNonce?: number;
    strings: { get: (key: string, ...args: any[]) => string };
    onCommitName?: (name: string) => void;
    onRequestJoinRoom: (room: OnlineRoomListing) => void;
    onSelectRoom?: (room: OnlineRoomListing | undefined) => void;
}

export const OnlineSetup: React.FC<OnlineSetupProps> = ({
    meshSession,
    onlineSession,
    lobbySession,
    lobbyChatHistory,
    resetNonce = 0,
    strings,
    onCommitName,
    onRequestJoinRoom,
    onSelectRoom,
}) => {
    const [meshSnapshot, setMeshSnapshot] = useState<LanMeshSnapshot>(meshSession.getSnapshot());
    const [nameInput, setNameInput] = useState(meshSession.getSnapshot().self.name);
    const [lobbyMessages, setLobbyMessages] = useState<UiLobbyChatMessage[]>(
        () => lobbyChatHistory.getAll() as UiLobbyChatMessage[]
    );
    const lastResetNonceRef = useRef(resetNonce);

    const supported = typeof RTCPeerConnection !== 'undefined';

    useEffect(() => {
        const handleMeshSnapshot = (nextSnapshot: LanMeshSnapshot) => {
            setMeshSnapshot(nextSnapshot);
            setNameInput((current) => (current === meshSnapshot.self.name ? nextSnapshot.self.name : current));
        };
        meshSession.onSnapshotChange.subscribe(handleMeshSnapshot);
        return () => {
            meshSession.onSnapshotChange.unsubscribe(handleMeshSnapshot);
        };
    }, [meshSession, meshSnapshot.self.name]);

    useEffect(() => {
        if (lastResetNonceRef.current === resetNonce) {
            return;
        }
        lastResetNonceRef.current = resetNonce;
        setNameInput(meshSession.getSnapshot().self.name);
    }, [meshSession, resetNonce]);

    useEffect(() => {
        const handleLobbyChat = (entry: LobbyChatMessage) => {
            const message = toUiLobbyMessage(entry);
            setLobbyMessages((current) => {
                // Defends against the same broadcast being appended twice —
                // observed intermittently in this custom jsx renderer, not
                // reproducible against the raw Colyseus wire protocol.
                // Comparing against the state array itself (rather than a
                // per-closure variable) catches it regardless of source,
                // keyed on the server's per-message timestamp.
                const last = current[current.length - 1];
                if (last && last.from === message.from && last.text === message.text && last.time.getTime() === message.time.getTime()) {
                    return current;
                }
                lobbyChatHistory.addChatMessage(message);
                return trimLobbyMessages([...current, message]);
            });
        };
        lobbySession.onChat.subscribe(handleLobbyChat);
        return () => {
            lobbySession.onChat.unsubscribe(handleLobbyChat);
        };
    }, [lobbySession, lobbyChatHistory]);

    const sendLobbyChat = (message: any) => {
        const value = typeof message === 'string' ? message : message?.value;
        if (typeof value === 'string' && value.trim()) {
            lobbySession.sendChat(value.trim());
        }
    };

    const commitName = () => {
        meshSession.updateSelfName(nameInput);
        const nextSelf = meshSession.getSnapshot().self;
        setMeshSnapshot(meshSession.getSnapshot());
        setNameInput(nextSelf.name);
        onCommitName?.(nextSelf.name);
    };

    const handleRequestJoin = (room: OnlineRoomListing) => {
        commitName();
        onRequestJoinRoom(room);
    };

    return (
        <div className="lobby-form lan-setup-form online-setup-form" data-online-view="entry">
            {!supported ? (
                <div className="lan-panel">
                    <h3>Environment Not Supported</h3>
                    <p>This browser has no WebRTC implementation available and cannot establish online connections on this page.</p>
                </div>
            ) : (
                <div className="lan-entry-layout">
                    <div className="lan-panel lan-entry-profile-panel-compact">
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

                    <OnlineRoomList onlineSession={onlineSession} onJoin={handleRequestJoin} onSelectRoom={onSelectRoom} strings={strings} />

                    <div className="lan-lobby-row">
                        <div className="lan-panel lan-lobby-chat-panel">
                            <div className="lan-panel-header">
                                <h3>Lobby Chat</h3>
                            </div>
                            <Chat
                                messages={lobbyMessages}
                                localUsername={nameInput}
                                channels={LOBBY_CHAT_CHANNELS}
                                strings={strings}
                                onSendMessage={sendLobbyChat}
                                onCancelMessage={() => {}}
                            />
                        </div>
                        <LobbyPlayerList lobbySession={lobbySession} />
                    </div>
                </div>
            )}
        </div>
    );
};
