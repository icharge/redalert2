import React from "react";
import { ServerList } from "@/gui/screen/mainMenu/login/ServerList";
import { BreakingNews } from "@/gui/screen/mainMenu/login/BreakingNews";
import type { Realm } from "@/network/Realm";

interface RealmSelectionBoxProps {
    breakingNewsUrl?: string;
    realms: Realm[];
    selectedRealm?: Realm;
    strings: any;
    onChange: (realmId: string) => void;
    onDoubleClick: (realmId: string) => void;
    onRequestRefresh: () => void;
}

export const RealmSelectionBox: React.FC<RealmSelectionBoxProps> = ({ breakingNewsUrl, realms, selectedRealm, strings, onChange, onDoubleClick, onRequestRefresh }) => React.createElement("div", { className: "login-wrapper selection-box realm-selection-box" }, React.createElement("div", { className: "title" }, strings.get("TS:RegionSelection")), React.createElement("div", { className: "login-form login-box" }, React.createElement("div", { className: "field" }, React.createElement(ServerList, {
    regionId: selectedRealm?.id,
    regions: realms,
    strings: strings,
    onChange: onChange,
    onDoubleClick: onDoubleClick,
}), React.createElement("button", {
    type: "button",
    className: "icon-button refresh-button",
    onClick: onRequestRefresh,
}))), React.createElement(BreakingNews, {
    strings: strings,
    url: breakingNewsUrl,
}));
