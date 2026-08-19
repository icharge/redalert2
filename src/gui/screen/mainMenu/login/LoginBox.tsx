import React, { useRef, useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { ServerList } from "@/gui/screen/mainMenu/login/ServerList";
import { LoginDebugUi } from "@/gui/screen/mainMenu/login/LoginDebugUi";
import { MIN_USERNAME_LEN, MAX_USERNAME_LEN, MAX_PASS_LEN } from "@/network/WolConfig";
import { CfTurnstileWidget } from "@/gui/component/CfTurnstileWidget";
import { AuthProviderButtons } from "@/gui/screen/mainMenu/login/AuthProviderButtons";
import { BreakingNews } from "@/gui/screen/mainMenu/login/BreakingNews";
import { CfTurnstile } from "@/util/CfTurnstile";
import { AuthProvider } from "@/conf/AuthProvidersConfig";

interface Region {
    id: string;
    label: string;
    available: boolean;
}

interface LoginBoxProps {
    regions: Region[];
    selectedRegion?: Region;
    breakingNewsUrl?: string;
    strings: any;
    authProviders: AuthProvider[];
    devMode: boolean;
    cfTurnstile: CfTurnstile;
    rememberLogin: boolean;
    savedUsername?: string;
    savedPassword?: string;
    onRegionChange: (regionId: string) => void;
    onRequestRegionRefresh: () => void;
    onTurnstileTokenChange: (token?: string) => void;
    onRememberLoginChange: (remember: boolean) => void;
    onSubmit: (username: string, password: string, remember?: boolean, turnstileToken?: string) => void;
    onAuthProviderLogin: (provider: AuthProvider) => void;
}

interface LoginBoxRef {
    submit(): void;
    resetTurnstile(): void;
}

export const LoginBox = forwardRef<LoginBoxRef, LoginBoxProps>(({ regions, selectedRegion, breakingNewsUrl, strings, authProviders, devMode, cfTurnstile, rememberLogin, savedUsername, savedPassword, onRegionChange, onRequestRegionRefresh, onTurnstileTokenChange, onRememberLoginChange, onSubmit, onAuthProviderLogin }, ref) => {
    const formRef = useRef<HTMLFormElement>(null);
    const usernameRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const turnstileTokenRef = useRef<string | undefined>(undefined);
    const [resetKey, setResetKey] = useState<number>();
    const [remember, setRemember] = useState<boolean>(rememberLogin);
    useEffect(() => {
        const focusTarget = savedUsername ? passwordRef.current : usernameRef.current;
        setTimeout(() => focusTarget?.focus(), 50);
    }, []);
    const handleSubmit = () => {
        if (usernameRef.current && passwordRef.current) {
            onSubmit(usernameRef.current.value, passwordRef.current.value, remember, turnstileTokenRef.current);
        }
    };
    const handleRememberChange = (checked: boolean) => {
        setRemember(checked);
        onRememberLoginChange(checked);
    };
    const handleTurnstileToken = (token?: string) => {
        turnstileTokenRef.current = token;
        onTurnstileTokenChange(token);
    };
    useImperativeHandle(ref, () => ({
        submit() {
            if (formRef.current?.requestSubmit) {
                formRef.current.requestSubmit();
            }
            else {
                handleSubmit();
            }
        },
        resetTurnstile() {
            handleTurnstileToken(undefined);
            setResetKey((key) => (key ?? 0) + 1);
        },
    }));
    return React.createElement("div", { className: "login-wrapper" }, React.createElement("div", { className: "title" }, strings.get("GUI:Login")), React.createElement("form", {
        onSubmit: (event: React.FormEvent) => {
            event.preventDefault();
            handleSubmit();
        },
        className: "login-form login-box",
        ref: formRef,
        autoComplete: "off",
    }, React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("TS:Region")), React.createElement(ServerList, {
        regionId: selectedRegion?.id,
        regions,
        strings,
        onChange: (regionId: string) => {
            onRegionChange(regionId);
        },
    }), React.createElement("button", {
        type: "button",
        className: "icon-button refresh-button",
        onClick: onRequestRegionRefresh,
    })), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Nickname")),     React.createElement("input", {
        name: "user",
        type: "text",
        required: true,
        minLength: MIN_USERNAME_LEN,
        maxLength: MAX_USERNAME_LEN,
        pattern: "[a-zA-Z0-9_\\-]+",
        autoComplete: "off",
        defaultValue: savedUsername ?? "",
        ref: usernameRef,
    })), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Password")), React.createElement("input", {
        name: "pass",
        type: "password",
        required: true,
        maxLength: MAX_PASS_LEN,
        autoComplete: "off",
        defaultValue: savedPassword ?? "",
        ref: passwordRef,
    })), React.createElement("div", { className: "field remember-login-field" }, React.createElement("label", { className: "remember-login" }, React.createElement("input", {
        type: "checkbox",
        checked: remember,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => handleRememberChange(event.currentTarget.checked),
    }), React.createElement("span", null, strings.get("NOSTR:Remember username & password")))), cfTurnstile.isEnabledForLogin() && React.createElement("div", { className: "field turnstile-field" }, React.createElement("label", null), cfTurnstile.isLoaded()
        ? React.createElement(CfTurnstileWidget, {
            cfTurnstile,
            action: "login",
            resetKey,
            onToken: handleTurnstileToken,
            onTokenExpired: () => handleTurnstileToken(undefined),
            onError: () => handleTurnstileToken(undefined),
        })
        : React.createElement("div", { className: "turnstile-error" }, strings.get("TS:TurnstileLoadFailed"))), React.createElement("button", {
        type: "submit",
        style: {
            visibility: "hidden",
            position: "absolute",
            width: 0,
            height: 0,
        },
    })), authProviders.length > 0 && React.createElement(AuthProviderButtons, {
        authProviders,
        strings,
        onLogin: onAuthProviderLogin,
    }), devMode && React.createElement(LoginDebugUi, {
        onSubmit,
    }), React.createElement(BreakingNews, {
        strings,
        url: breakingNewsUrl,
    }));
});
