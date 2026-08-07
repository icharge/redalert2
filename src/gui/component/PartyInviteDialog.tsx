import React, { useState } from "react";
import { Dialog } from "@/gui/component/Dialog";
import { Strings } from "@/data/Strings";

interface PartyInviteDialogProps {
    inviterName: string;
    strings: Strings;
    showPreventionCheckbox?: boolean;
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    onAccept: () => void;
    onDecline: (preventInvites: boolean) => void;
}

export const PartyInviteDialog: React.FC<PartyInviteDialogProps> = ({ inviterName, strings, showPreventionCheckbox = false, viewport, onAccept, onDecline }) => {
    const [hidden, setHidden] = useState(false);
    const [preventInvites, setPreventInvites] = useState(false);
    return (<Dialog hidden={hidden} viewport={viewport} zIndex={100} buttons={[
        {
            label: strings.get("GUI:PartyInviteAccept"),
            disabled: showPreventionCheckbox && preventInvites,
            onClick: () => {
                setHidden(true);
                onAccept();
            },
        },
        {
            label: strings.get("GUI:PartyInviteDecline"),
            onClick: () => {
                setHidden(true);
                onDecline(preventInvites);
            },
        },
    ]}>
        <div>
            <div style={{ marginBottom: showPreventionCheckbox ? "12px" : "0" }}>
                {strings.get("GUI:PartyInviteReceived", inviterName)}
            </div>
            {showPreventionCheckbox && (<label style={{
                    display: "flex",
                    alignItems: "center",
                    cursor: "pointer",
                    marginBottom: "8px",
                }}>
                <input type="checkbox" checked={preventInvites} onChange={(e) => setPreventInvites(e.target.checked)} style={{
                        marginRight: "8px",
                        cursor: "pointer",
                    }}/>
                <span style={{ fontSize: "12px", color: "yellow" }}>
                    {strings.get("GUI:PartyInvitePrevent", 60)}
                </span>
            </label>)}
        </div>
    </Dialog>);
};
