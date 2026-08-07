import React from "react";
import { List, ListItem } from "@/gui/component/List";

interface Region {
    id: string;
    label: string;
    available: boolean;
}

interface ServerListProps {
    regionId?: string;
    regions: Region[];
    strings: any;
    onChange: (regionId: string) => void;
    onDoubleClick?: (regionId: string) => void;
}

export const ServerList: React.FC<ServerListProps> = ({ regionId, regions, strings, onChange, onDoubleClick }) => React.createElement(List, { className: "server-list" }, regions.map((region) => {
    const disabled = !region.available;
    return React.createElement(ListItem, {
        key: region.id,
        selected: region.id === regionId && !disabled,
        disabled,
        onClick: () => !disabled && onChange(region.id),
        onDoubleClick: () => !disabled && onDoubleClick?.(region.id),
    }, React.createElement("span", { className: "label" }, region.label), React.createElement("span", { className: "ping" }, disabled
        ? React.createElement("span", { className: "offline-text" }, strings.get("TS:ServerOffline"))
        : React.createElement("span", { className: "online-text" }, strings.get("TS:ServerOnline"))));
}));
