import React from "react";
import { CfTurnstileWidget } from "@/gui/component/CfTurnstileWidget";

export class CfPreclearanceApi {
    private task?: Promise<void>;

    constructor(private cfTurnstile: any, private messageBoxApi: any, private strings: any) {
    }

    async preClearance(): Promise<void> {
        if (!this.task) {
            this.task = new Promise<void>((resolve, reject) => {
                let finished = false;
                const finish = (callback: () => void) => {
                    if (!finished) {
                        finished = true;
                        this.messageBoxApi.destroy();
                        callback();
                    }
                };
                this.messageBoxApi.show(React.createElement("div", {
                    className: "turnstile-clearance-dialog",
                },
                    React.createElement("div", {
                        className: "turnstile-clearance-text",
                    }, this.strings.get("TS:TurnstilePreclearance")),
                    React.createElement(CfTurnstileWidget, {
                        cfTurnstile: this.cfTurnstile,
                        action: "preclearance",
                        onToken: () => finish(() => resolve()),
                        onError: () => finish(() => reject(new Error("Cloudflare Turnstile pre-clearance failed"))),
                    })), this.strings.get("GUI:Cancel"), () => finish(() => reject(new Error("Cloudflare Turnstile pre-clearance cancelled"))));
            }).finally(() => {
                this.task = undefined;
            });
        }
        await this.task;
    }
}
