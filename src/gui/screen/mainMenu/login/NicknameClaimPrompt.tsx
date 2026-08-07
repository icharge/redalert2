import React from "react";
import { AuthProviderButtons } from "@/gui/screen/mainMenu/login/AuthProviderButtons";
import { AuthProvider } from "@/conf/AuthProvidersConfig";

interface NicknameClaimPromptProps {
    nickname: string;
    strings: any;
    authProviders: AuthProvider[];
    onDontShowAgainChange: (checked: boolean) => void;
    onLogin: (provider: AuthProvider) => void;
}

export const NicknameClaimPrompt: React.FC<NicknameClaimPromptProps> = ({ nickname, strings, authProviders, onDontShowAgainChange, onLogin }) => React.createElement("div", { className: "claim-nickname-prompt" },
    React.createElement("div", { className: "claim-nickname-title" }, strings.get("TS:ClaimNicknameTitle")),
    React.createElement("div", { className: "claim-nickname-description" }, strings.get("TS:ClaimNicknamePrompt", nickname)),
    React.createElement("div", { className: "claim-nickname-warning" }, strings.get("TS:ClaimNicknamePermanent")),
    React.createElement("label", null, React.createElement("input", {
        type: "checkbox",
        onChange: (event) => onDontShowAgainChange(event.currentTarget.checked),
    }), React.createElement("span", null, strings.get("TS:DontShowAgain"))),
    React.createElement(AuthProviderButtons, {
        authProviders,
        strings,
        standalone: true,
        heading: strings.get("TS:ClaimNicknameWith"),
        onLogin,
    }));
