import React, { useCallback, useEffect, useState } from 'react';
import { List, ListHeader, ListItem } from '@/gui/component/List';
import { OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';

const POLL_INTERVAL_MILLIS = 5000;

interface OnlineRoomListProps {
    onlineSession: OnlineRoomSession;
    onJoin: (room: OnlineRoomListing) => void;
    busy?: boolean;
}

export const OnlineRoomList: React.FC<OnlineRoomListProps> = ({ onlineSession, onJoin, busy }) => {
    const [rooms, setRooms] = useState<OnlineRoomListing[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const listing = await onlineSession.listRooms();
            setRooms(listing);
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

    return (
        <div className="lan-panel online-room-list-panel">
            <div className="lan-panel-header">
                <h3>Open Rooms</h3>
                <button type="button" className="dialog-button" disabled={loading} onClick={() => void refresh()}>
                    {loading ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>
            {error ? <div className="lan-entry-field-hint tone-bad">{error}</div> : null}
            {rooms.length ? (
                <List className="online-room-list">
                    <ListHeader className="online-room-list-header">
                        <span>Room</span>
                        <span>Host</span>
                        <span>Mode / Map</span>
                        <span>Players</span>
                        <span />
                    </ListHeader>
                    {rooms.map((room) => (
                        <ListItem className="online-room-list-item" key={room.roomId}>
                            <span>
                                {room.metadata.passwordProtected ? <span title="Password protected">🔒 </span> : null}
                                {room.metadata.label || room.roomId}
                            </span>
                            <span>{room.metadata.hostName}</span>
                            <span>{room.metadata.gameModeLabel} · {room.metadata.mapTitle || (room.metadata.mapOfficial ? 'Official Map' : 'Custom Map')}</span>
                            <span>{room.clients}/{room.maxClients}</span>
                            <button
                                type="button"
                                className="dialog-button"
                                disabled={busy || room.clients >= room.maxClients}
                                onClick={() => onJoin(room)}
                            >
                                Join
                            </button>
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
