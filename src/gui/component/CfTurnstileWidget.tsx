import React, { useRef, useEffect } from "react";
import type { CfTurnstile } from "@/util/CfTurnstile";

interface CfTurnstileWidgetProps {
    cfTurnstile: CfTurnstile;
    action: string;
    resetKey?: number;
    onToken: (token: string) => void;
    onTokenExpired?: () => void;
    onError?: (error: any) => void;
}

export const CfTurnstileWidget: React.FC<CfTurnstileWidgetProps> = ({ cfTurnstile, action, resetKey, onToken, onTokenExpired, onError }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const resetRef = useRef<(() => void) | undefined>(undefined);
    const onTokenRef = useRef<((token: string) => void) | undefined>(onToken);
    const onTokenExpiredRef = useRef<(() => void) | undefined>(onTokenExpired);
    const onErrorRef = useRef<((error?: any) => void) | undefined>(onError);
    useEffect(() => {
        onTokenRef.current = onToken;
        onTokenExpiredRef.current = onTokenExpired;
        onErrorRef.current = onError;
    }, [onToken, onTokenExpired, onError]);
    useEffect(() => {
        if (containerRef.current) {
            const widgetId = cfTurnstile.render(containerRef.current, action, {
                onToken: (token: string) => onTokenRef.current?.(token),
                onTokenExpired: () => onTokenExpiredRef.current?.(),
                onError: () => onErrorRef.current?.(),
            });
            resetRef.current = () => cfTurnstile.reset(widgetId);
            return () => {
                resetRef.current = undefined;
                cfTurnstile.remove(widgetId);
            };
        }
    }, [action, cfTurnstile]);
    useEffect(() => {
        if (resetKey !== undefined) {
            resetRef.current?.();
        }
    }, [resetKey]);
    return React.createElement("div", {
        className: "turnstile-widget",
        ref: containerRef,
    });
};
