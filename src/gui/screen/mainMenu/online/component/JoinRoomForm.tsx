import React, { useEffect, useRef } from 'react';

interface JoinRoomFormProps {
    hostName: string;
    description?: string;
    passwordRequired: boolean;
    valuesRef: { current: { password: string } };
    onSubmit: () => void;
}

export const JoinRoomForm: React.FC<JoinRoomFormProps> = ({ hostName, description, passwordRequired, valuesRef, onSubmit }) => {
    const passwordInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => passwordInputRef.current?.focus(), 50);
    }, []);

    const handleSubmit = (event?: React.FormEvent) => {
        event?.preventDefault();
        onSubmit();
    };

    return (
        <form onSubmit={handleSubmit} autoComplete="off">
            <p>{hostName}'s room</p>
            {description ? <p>{description}</p> : null}
            <div className="field">
                <label htmlFor="online-join-password">
                    {passwordRequired ? 'Password (required)' : 'Password (leave blank if none)'}
                </label>
                <input
                    id="online-join-password"
                    ref={passwordInputRef}
                    type="password"
                    autoComplete="off"
                    data-lpignore="true"
                    onChange={(event) => { valuesRef.current.password = event.target.value; }}
                />
            </div>
            <button type="submit" style={{ visibility: 'hidden' }} />
        </form>
    );
};
