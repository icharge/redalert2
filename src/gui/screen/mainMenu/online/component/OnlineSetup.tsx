import React, { useEffect, useRef, useState } from 'react';
import { LanMeshSession, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';
import { OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomList } from '@/gui/screen/mainMenu/online/component/OnlineRoomList';

interface OnlineSetupProps {
    meshSession: LanMeshSession;
    onlineSession: OnlineRoomSession;
    resetNonce?: number;
    onCommitName?: (name: string) => void;
    onRequestJoinRoom: (room: OnlineRoomListing) => void;
}

export const OnlineSetup: React.FC<OnlineSetupProps> = ({
    meshSession,
    onlineSession,
    resetNonce = 0,
    onCommitName,
    onRequestJoinRoom,
}) => {
    const [meshSnapshot, setMeshSnapshot] = useState<LanMeshSnapshot>(meshSession.getSnapshot());
    const [nameInput, setNameInput] = useState(meshSession.getSnapshot().self.name);
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
            )}
        </div>
    );
};
