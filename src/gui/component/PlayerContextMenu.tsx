import React, { useRef, useEffect } from "react";
import { List, ListItem } from "@/gui/component/List";

export interface PlayerContextMenuItem {
    label: string;
    disabled?: boolean;
    onClick: () => void;
}

interface PlayerContextMenuProps {
    items: PlayerContextMenuItem[];
    onClose: () => void;
}

export const PlayerContextMenu: React.FC<PlayerContextMenuProps> = ({ items, onClose }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handleMouseDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener("mousedown", handleMouseDown);
        return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [onClose]);
    return (<List className="player-context-menu" innerRef={menuRef}>
        {items.map((item, index) => (<ListItem key={index} className="player-context-menu-item" disabled={item.disabled} onClick={(e) => {
                e.stopPropagation();
                if (!item.disabled) {
                    item.onClick();
                }
            }}>
            {item.label}
        </ListItem>))}
    </List>);
};
