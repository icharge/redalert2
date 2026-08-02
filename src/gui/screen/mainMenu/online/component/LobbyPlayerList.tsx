import React, { useEffect, useState } from 'react';
import { List, ListItem } from '@/gui/component/List';
import { LobbyChannelSession, LobbyMemberSnapshot } from '@/network/colyseus/LobbyChannelSession';

interface LobbyPlayerListProps {
    lobbySession: LobbyChannelSession;
}

export const LobbyPlayerList: React.FC<LobbyPlayerListProps> = ({ lobbySession }) => {
    const [members, setMembers] = useState<LobbyMemberSnapshot[]>(lobbySession.getMembers());
    const [selectedSessionId, setSelectedSessionId] = useState<string>();

    useEffect(() => {
        const handleMembersChanged = (next: LobbyMemberSnapshot[]) => setMembers(next);
        lobbySession.onMembersChanged.subscribe(handleMembersChanged);
        setMembers(lobbySession.getMembers());
        return () => {
            lobbySession.onMembersChanged.unsubscribe(handleMembersChanged);
        };
    }, [lobbySession]);

    useEffect(() => {
        if (selectedSessionId && !members.some((member) => member.sessionId === selectedSessionId)) {
            setSelectedSessionId(undefined);
        }
    }, [members, selectedSessionId]);

    return (
        <div className="lan-panel lobby-player-list-panel">
            <div className="lan-panel-header">
                <h3>Players Online</h3>
                <span>{members.length}</span>
            </div>
            {members.length ? (
                <List className="lobby-player-list">
                    {members.map((member) => (
                        <ListItem
                            className="lobby-player-list-item"
                            key={member.sessionId}
                            selected={member.sessionId === selectedSessionId}
                            onClick={() => setSelectedSessionId(member.sessionId)}
                        >
                            <span>{member.name}</span>
                        </ListItem>
                    ))}
                </List>
            ) : (
                <div className="lan-entry-empty-state">No players online right now.</div>
            )}
        </div>
    );
};
