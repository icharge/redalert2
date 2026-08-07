import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { MIN_USERNAME_LEN, MAX_USERNAME_LEN, MIN_PASS_LEN, MAX_PASS_LEN } from "@/network/WolConfig";
import { CfTurnstileWidget } from "@/gui/component/CfTurnstileWidget";
import { AuthProviderButtons } from "@/gui/screen/mainMenu/login/AuthProviderButtons";
import { CfTurnstile } from "@/util/CfTurnstile";
import { AuthProvider } from "@/conf/AuthProvidersConfig";

interface Region {
    id: string;
    label: string;
    available: boolean;
}

interface NewAccountFormData {
    user: string;
    pass: string;
    passMatch: boolean;
    regionId: string;
    turnstileToken?: string;
}

interface NewAccountBoxProps {
    regions: Region[];
    initialRegion: Region;
    strings: any;
    authProviders: AuthProvider[];
    legacyRegistrationEnabled: boolean;
    cfTurnstile: CfTurnstile;
    onRegionChange: (regionId: string) => void;
    onTurnstileTokenChange: (token?: string) => void;
    onSubmit: (formData: NewAccountFormData) => void;
    onAuthProviderLogin: (provider: AuthProvider) => void;
}

interface NewAccountBoxRef {
    submit(): void;
    resetTurnstile(): void;
}

export const NewAccountBox = forwardRef<NewAccountBoxRef, NewAccountBoxProps>(({ regions, initialRegion, strings, authProviders, legacyRegistrationEnabled, cfTurnstile, onRegionChange, onTurnstileTokenChange, onSubmit, onAuthProviderLogin }, ref) => {
    const [selectedRegionId, setSelectedRegionId] = useState(initialRegion.id);
    const formRef = useRef<HTMLFormElement>(null);
    const usernameRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const confirmPasswordRef = useRef<HTMLInputElement>(null);
    const turnstileTokenRef = useRef<string | undefined>(undefined);
    const [resetKey, setResetKey] = useState<number>();
    useEffect(() => {
        setTimeout(() => usernameRef.current?.focus(), 50);
    }, []);
    const handleSubmit = () => {
        onSubmit({
            user: usernameRef.current!.value,
            pass: passwordRef.current!.value,
            passMatch: passwordRef.current!.value === confirmPasswordRef.current!.value,
            regionId: selectedRegionId,
            turnstileToken: turnstileTokenRef.current,
        });
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
    return React.createElement("div", { className: "login-wrapper new-account-box" }, React.createElement("div", { className: "title" }, strings.get("GUI:NewAccount")), legacyRegistrationEnabled && React.createElement("form", {
        onSubmit: (event: React.FormEvent) => {
            event.preventDefault();
            handleSubmit();
        },
        className: "login-form login-box",
        ref: formRef,
    }, regions.length > 1
        ? React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("TS:Region")), React.createElement("select", {
            name: "server",
            value: selectedRegionId,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                const regionId = event.target.value;
                setSelectedRegionId(regionId);
                onRegionChange(regionId);
            },
        }, regions.map((region) => React.createElement("option", {
            value: region.id,
            key: region.id,
            disabled: !region.available,
        }, region.label))))
        : React.createElement("input", {
            type: "hidden",
            name: "server",
            value: selectedRegionId,
        }), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Nickname")), React.createElement("input", {
        name: "user",
        type: "text",
        required: true,
        minLength: MIN_USERNAME_LEN,
        maxLength: MAX_USERNAME_LEN,
        ref: usernameRef,
        autoComplete: "off",
    })), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Password")), React.createElement("input", {
        name: "pass",
        type: "password",
        required: true,
        minLength: MIN_PASS_LEN,
        maxLength: MAX_PASS_LEN,
        ref: passwordRef,
        autoComplete: "off",
    })), React.createElement("div", { className: "field" }, React.createElement("label", null, strings.get("GUI:Re-enterPassword")), React.createElement("input", {
        name: "confirmPass",
        type: "password",
        required: true,
        ref: confirmPasswordRef,
        autoComplete: "off",
    })), cfTurnstile.isEnabled() && React.createElement("div", { className: "field turnstile-field" }, React.createElement("label", null), cfTurnstile.isLoaded()
        ? React.createElement(CfTurnstileWidget, {
            cfTurnstile,
            action: "register",
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
        standalone: !legacyRegistrationEnabled,
    }));
});
