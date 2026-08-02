import React, { useEffect, useRef, useState } from 'react';

export interface CreateRoomFormValues {
    description: string;
    maxPlayers: number;
    password: string;
}

interface CreateRoomFormProps {
    valuesRef: { current: CreateRoomFormValues };
    onSubmit: () => void;
}

const MAX_PLAYER_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

export const CreateRoomForm: React.FC<CreateRoomFormProps> = ({ valuesRef, onSubmit }) => {
    const descriptionInputRef = useRef<HTMLInputElement>(null);
    const [passwordEnabled, setPasswordEnabled] = useState(false);

    useEffect(() => {
        setTimeout(() => descriptionInputRef.current?.focus(), 50);
    }, []);

    const handleSubmit = (event?: React.FormEvent) => {
        event?.preventDefault();
        onSubmit();
    };

    return (
        <form onSubmit={handleSubmit} autoComplete="off">
            <div className="field">
                <label htmlFor="online-create-description">Room Description (optional)</label>
                <input
                    id="online-create-description"
                    ref={descriptionInputRef}
                    type="text"
                    maxLength={60}
                    autoComplete="off"
                    data-lpignore="true"
                    onChange={(event) => { valuesRef.current.description = event.target.value; }}
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
                <label htmlFor="online-create-password-enabled">
                    <input
                        id="online-create-password-enabled"
                        type="checkbox"
                        checked={passwordEnabled}
                        onChange={(event) => {
                            setPasswordEnabled(event.target.checked);
                            if (!event.target.checked) {
                                valuesRef.current.password = '';
                            }
                        }}
                    />
                    {' '}Password
                </label>
                <input
                    id="online-create-password"
                    type="password"
                    maxLength={32}
                    disabled={!passwordEnabled}
                    autoComplete="off"
                    data-lpignore="true"
                    onChange={(event) => { valuesRef.current.password = event.target.value; }}
                />
            </div>
            <button type="submit" style={{ visibility: 'hidden' }} />
        </form>
    );
};
