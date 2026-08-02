import React, { useCallback, useEffect, useState } from 'react';
import { List, ListHeader, ListItem } from '@/gui/component/List';
import { Image } from '@/gui/component/Image';
import { PingIndicator } from '@/gui/component/PingIndicator';
import { OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';

const POLL_INTERVAL_MILLIS = 5000;

interface OnlineRoomListProps {
    onlineSession: OnlineRoomSession;
    onJoin: (room: OnlineRoomListing) => void;
    onSelectRoom?: (room: OnlineRoomListing | undefined) => void;
    strings: { get: (key: string, ...args: any[]) => string };
}

export const OnlineRoomList: React.FC<OnlineRoomListProps> = ({ onlineSession, onJoin, onSelectRoom, strings }) => {
    const [rooms, setRooms] = useState<OnlineRoomListing[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [selectedRoomId, setSelectedRoomId] = useState<string>();
    // Every room lives on the same relay server, so there's one meaningful
    // "ping" for the whole list rather than a per-room value — measured off
    // the same /rooms request the list itself already polls with.
    const [serverPing, setServerPing] = useState<number>();

    const refresh = useCallback(async () => {
        setLoading(true);
        const requestStartedAt = performance.now();
        try {
            const listing = await onlineSession.listRooms();
            setServerPing(Math.round(performance.now() - requestStartedAt));
            // Locked rooms (manually locked, or already in-game) stay visible
            // rather than vanishing — sorted after everything joinable.
            const sorted = [...listing].sort((left, right) => Number(left.locked) - Number(right.locked));
            setRooms(sorted);
            setError(undefined);
        }
        catch (err) {
            setError((err as Error).message);
        }
        finally {
            setLoading(false);
        }
    }, [onlineSession]);

    useEffect(() => {
        void refresh();
        const intervalId = window.setInterval(() => {
            void refresh();
        }, POLL_INTERVAL_MILLIS);
        return () => window.clearInterval(intervalId);
    }, [refresh]);

    useEffect(() => {
        if (selectedRoomId && !rooms.some((room) => room.roomId === selectedRoomId)) {
            setSelectedRoomId(undefined);
            onSelectRoom?.(undefined);
        }
    }, [rooms, selectedRoomId, onSelectRoom]);

    const selectRoom = (room: OnlineRoomListing) => {
        setSelectedRoomId(room.roomId);
        onSelectRoom?.(room);
    };

    return (
        <div className="lan-panel online-room-list-panel">
            <div className="lan-panel-header">
                <h3>Available Games</h3>
                <button type="button" className="dialog-button" disabled={loading} onClick={() => void refresh()}>
                    {loading ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>
            {error ? <div className="lan-entry-field-hint tone-bad">{error}</div> : null}
            {rooms.length ? (
                <List className="online-room-list">
                    <ListHeader className="online-room-list-header">
                        <span>Map</span>
                        <span>Room Description</span>
                        <span>Players</span>
                        <span>Host</span>
                        <span>Ping</span>
                    </ListHeader>
                    {rooms.map((room) => (
                        <ListItem
                            className={`online-room-list-item${room.locked ? ' online-room-list-item-locked' : ''}`}
                            key={room.roomId}
                            selected={room.roomId === selectedRoomId}
                            onClick={() => selectRoom(room)}
                            onDoubleClick={() => onJoin(room)}
                        >
                            <span className="online-room-map-cell">
                                <Image src={room.metadata.mapOfficial ? 'gt18.pcx' : 'settings.png'}/>
                                {room.metadata.mapTitle || 'Unknown Map'}
                            </span>
                            <span>
                                {room.locked ? (
                                    <span className="online-room-lock-icon" title="Room locked — not accepting new players">
                                        <Image src="wolpriv.pcx"/>
                                    </span>
                                ) : room.metadata.passwordProtected ? (
                                    <span className="online-room-lock-icon" title="Password protected">
                                        <Image src="wolpriv.pcx"/>
                                    </span>
                                ) : null}
                                {room.metadata.description || ''}
                            </span>
                            <span>{room.clients}/{room.maxClients}</span>
                            <span>{room.metadata.hostName}</span>
                            <span><PingIndicator ping={serverPing} strings={strings}/></span>
                        </ListItem>
                    ))}
                </List>
            ) : (
                <div className="lan-entry-empty-state">
                    {loading ? 'Looking for open rooms...' : 'No open rooms right now. Create one to get started.'}
                </div>
            )}
        </div>
    );
};
