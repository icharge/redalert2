import React, { useEffect, useRef } from 'react';

export interface CreateRoomFormValues {
    roomName: string;
    maxPlayers: number;
    password: string;
}

interface CreateRoomFormProps {
    defaultRoomName: string;
    valuesRef: { current: CreateRoomFormValues };
    onSubmit: () => void;
}

const MAX_PLAYER_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

export const CreateRoomForm: React.FC<CreateRoomFormProps> = ({ defaultRoomName, valuesRef, onSubmit }) => {
    const nameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => nameInputRef.current?.focus(), 50);
    }, []);

    const handleSubmit = (event?: React.FormEvent) => {
        event?.preventDefault();
        onSubmit();
    };

    return (
        <form onSubmit={handleSubmit} autoComplete="off">
            <div className="field">
                <label htmlFor="online-create-room-name">Room Name</label>
                <input
                    id="online-create-room-name"
                    ref={nameInputRef}
                    type="text"
                    maxLength={40}
                    defaultValue={defaultRoomName}
                    autoComplete="off"
                    data-lpignore="true"
                    onChange={(event) => { valuesRef.current.roomName = event.target.value; }}
                />
            </div>
            <div className="field">
                <label htmlFor="online-create-max-players">Max Players</label>
                <select
                    id="online-create-max-players"
                    defaultValue={valuesRef.current.maxPlayers}
                    onChange={(event) => { valuesRef.current.maxPlayers = Number(event.target.value); }}
                >
                    {MAX_PLAYER_OPTIONS.map((count) => (
                        <option key={count} value={count}>{count}</option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label htmlFor="online-create-password">Password (optional)</label>
                <input
                    id="online-create-password"
                    type="password"
                    maxLength={32}
                    autoComplete="off"
                    data-lpignore="true"
                    onChange={(event) => { valuesRef.current.password = event.target.value; }}
                />
            </div>
            <button type="submit" style={{ visibility: 'hidden' }} />
        </form>
    );
};
