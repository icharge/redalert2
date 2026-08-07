import React from "react";
import { List, ListItem } from "@/gui/component/List";

interface NicknameSelectionBoxProps {
    strings: any;
    nicknames: string[];
    maxNicknames: number;
    selectedNickname?: string;
    autoLogin: boolean;
    onChange: (nickname: string) => void;
    onDoubleClick: (nickname: string) => void;
    onAutoLoginChange: (autoLogin: boolean) => void;
}

export const NicknameSelectionBox: React.FC<NicknameSelectionBoxProps> = ({ strings, nicknames, maxNicknames, selectedNickname, autoLogin, onChange, onDoubleClick, onAutoLoginChange }) => React.createElement("div", { className: "login-wrapper selection-box nickname-selection-box" }, React.createElement("div", { className: "title" }, strings.get("TS:NicknameSelection")), React.createElement("div", { className: "login-form login-box" }, React.createElement("div", { className: "field" }, React.createElement(List, { className: "nickname-list" }, nicknames.length ? nicknames.map(nickname => React.createElement(ListItem, {
    key: nickname,
    selected: nickname === selectedNickname,
    onClick: () => onChange(nickname),
    onDoubleClick: () => onDoubleClick(nickname),
}, nickname)) : React.createElement(ListItem, { disabled: true }, strings.get("TS:NoNicknames"))), maxNicknames > 0 && React.createElement("div", { className: "nickname-capacity" }, strings.get("TS:NicknameCapacity", nicknames.length, maxNicknames)), React.createElement("label", { className: "auto-login-nickname" }, React.createElement("input", {
    type: "checkbox",
    checked: autoLogin,
    onChange: event => onAutoLoginChange(event.currentTarget.checked),
}), React.createElement("span", null, strings.get("TS:AutoLoginNickname"))))));
