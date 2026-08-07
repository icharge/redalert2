import React, { useRef, useState, useEffect } from "react";
import { Dialog } from "@/gui/component/Dialog";
import { RecentPlayersList } from "@/gui/screen/mainMenu/quickGame/component/RecentPlayersList";
import { Strings } from "@/data/Strings";
import { PlayerRankType } from "@/network/ladder/PlayerRankType";

interface PlayerProfile {
    name: string;
    rankType: PlayerRankType;
}

interface SendPartyInviteDialogProps {
    strings: Strings;
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    recentPlayers: PlayerProfile[];
    onSubmit: (name: string) => void;
    onDismiss: () => void;
}

export const SendPartyInviteDialog: React.FC<SendPartyInviteDialogProps> = ({ strings, viewport, recentPlayers, onSubmit, onDismiss }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        setTimeout(() => {
            inputRef.current?.focus();
        }, 50);
    }, []);
    const handleSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        const name = inputRef.current?.value?.trim();
        if (name) {
            setHidden(true);
            onSubmit(name);
        }
    };
    return (<Dialog className="prompt-box" hidden={hidden} viewport={viewport} zIndex={100} buttons={[
        {
            label: strings.get("GUI:OK"),
            onClick: handleSubmit,
        },
        {
            label: strings.get("GUI:Cancel"),
            onClick: () => {
                setHidden(true);
                onDismiss();
            },
        },
    ]}>
        <form onSubmit={handleSubmit} autoComplete="off">
            <div className="field">
                <label>
                    {strings.get("GUI:InvitePlayerPrompt")}
                </label>
                <input name="promptvalue" type="text" autoComplete="off" data-lpignore="true" ref={inputRef}/>
            </div>
            <RecentPlayersList strings={strings} title={strings.get("GUI:RecentlyPlayedWith")} players={recentPlayers} onSelect={(name) => {
                if (inputRef.current) {
                    inputRef.current.value = name;
                }
            }}/>
            <button type="submit" style={{ visibility: "hidden" }}/>
        </form>
    </Dialog>);
};
