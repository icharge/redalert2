import React, { useRef, useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { CfTurnstileWidget } from "@/gui/component/CfTurnstileWidget";
import { MIN_USERNAME_LEN, MAX_USERNAME_LEN, MAX_PASS_LEN } from "@/network/WolConfig";
import type { CfTurnstile } from "@/util/CfTurnstile";

export interface NicknameClaimCredentials {
    user: string;
    pass: string;
    turnstileToken?: string;
}

export interface NicknameClaimCredentialsPromptApi {
    submit(): boolean;
}

interface NicknameClaimCredentialsPromptProps {
    strings: any;
    cfTurnstile: CfTurnstile;
    onSubmit: (credentials: NicknameClaimCredentials) => void;
}

export const NicknameClaimCredentialsPrompt = forwardRef<NicknameClaimCredentialsPromptApi, NicknameClaimCredentialsPromptProps>(({ strings, cfTurnstile, onSubmit }, ref) => {
    const usernameRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const [turnstileToken, setTurnstileToken] = useState<string>();
    useEffect(() => {
        setTimeout(() => usernameRef.current?.focus(), 50);
    }, []);
    const turnstileEnabled = cfTurnstile.isEnabledForLogin();
    const submit = (): boolean => {
        if (turnstileEnabled && !turnstileToken) {
            return false;
        }
        if (!usernameRef.current!.reportValidity() || !passwordRef.current!.reportValidity()) {
            return false;
        }
        onSubmit({
            user: usernameRef.current!.value,
            pass: passwordRef.current!.value,
            turnstileToken,
        });
        return true;
    };
    useImperativeHandle(ref, () => ({
        submit,
    }));
    return React.createElement("form", {
        className: "login-box nickname-claim-credentials-form",
        onSubmit: (event: React.FormEvent) => {
            event.preventDefault();
            submit();
        },
        autoComplete: "off",
    }, React.createElement("div", { className: "nickname-claim-credentials-description" }, strings.get("TS:ClaimNicknameCredentials")), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Nickname")), React.createElement("input", {
        name: "user",
        type: "text",
        autoComplete: "off",
        "data-lpignore": "true",
        ref: usernameRef,
        required: true,
        minLength: MIN_USERNAME_LEN,
        maxLength: MAX_USERNAME_LEN,
        pattern: "[a-zA-Z0-9_\\-]+",
    })), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Password")), React.createElement("input", {
        name: "pass",
        type: "password",
        autoComplete: "off",
        "data-lpignore": "true",
        ref: passwordRef,
        required: true,
        maxLength: MAX_PASS_LEN,
    })), turnstileEnabled && React.createElement("div", { className: "field turnstile-field" }, React.createElement("label", null), cfTurnstile.isLoaded() ? React.createElement(CfTurnstileWidget, {
        cfTurnstile: cfTurnstile,
        action: "login",
        onToken: setTurnstileToken,
        onTokenExpired: () => setTurnstileToken(undefined),
        onError: () => setTurnstileToken(undefined),
    }) : React.createElement("div", { className: "turnstile-error" }, strings.get("TS:TurnstileLoadFailed"))), React.createElement("button", {
        type: "submit",
        style: {
            visibility: "hidden",
            position: "absolute",
            width: 0,
            height: 0,
        },
    }));
});
