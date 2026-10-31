// HTTP surface for the WDT state and its operator actions.
//
// Public:  GET /wdt/state?cycle=current|previous   binary client packet
//          GET /wdt/status                         JSON cycle/conflicts/history
// Admin:   POST /wdt/admin/rollover                freeze current, start a cycle
//          POST /wdt/admin/reset                   discard the cycle, start fresh
//          POST /wdt/admin/enable {"enabled":bool} stop/start serving WDT
//          GET  /wdt/admin/status                  admin view
//
// The admin routes require the same bearer session and ADMIN_USERNAMES list as
// /admin/*; the guard is passed in by the HTTP router so this module stays
// free of account/config coupling.

import { WdtService } from "./service";
import { WdtError } from "./types";

export type WdtAdminGuard = (req: Request) => boolean;

function queryCycle(url: URL): "current" | "previous" {
    return url.searchParams.get("cycle") === "previous" ? "previous" : "current";
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** Returns a response for /wdt/*, or undefined for another path. */
export async function handleWdt(req: Request, service: WdtService, isAdmin: WdtAdminGuard = () => false): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/wdt/admin/")) {
        if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
        return handleAdmin(req, service, url.pathname.slice("/wdt/admin/".length));
    }
    if (url.pathname === "/wdt/state") {
        if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        try {
            const packet = service.packet(queryCycle(url));
            return new Response(packet, {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Cache-Control": "no-store",
                    "Content-Length": String(packet.length),
                },
            });
        }
        catch (error) {
            if (error instanceof WdtError && error.code === "disabled") {
                return new Response("World Domination is disabled", { status: 503 });
            }
            const reason = error instanceof WdtError ? error.message : "unavailable";
            return new Response(reason, { status: 404 });
        }
    }
    if (url.pathname === "/wdt/status") {
        if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return json(service.summary());
    }
    return undefined;
}

function handleAdmin(req: Request, service: WdtService, action: string): Promise<Response> | Response {
    const summary = service.summary() as { cycle: unknown };
    switch (action) {
        case "rollover": {
            if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
            service.advanceCycle();
            return json({ ok: true, cycle: (service.summary() as { cycle: unknown }).cycle });
        }
        case "reset": {
            if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
            service.reset();
            return json({ ok: true, cycle: (service.summary() as { cycle: unknown }).cycle });
        }
        case "enable": {
            if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
            return req.text().then(text => {
                let enabled = true;
                if (text.trim()) {
                    try {
                        const body = JSON.parse(text) as { enabled?: unknown };
                        enabled = body.enabled === undefined ? true : Boolean(body.enabled);
                    }
                    catch {
                        return json({ error: "Invalid request body" }, 400);
                    }
                }
                service.setEnabled(enabled);
                return json({ ok: true, enabled: service.isEnabled() });
            });
        }
        case "status":
            if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
            return json({ ...(service.summary() as object), enabled: service.isEnabled() });
        default:
            return json({ error: "Not Found", cycle: summary.cycle }, 404);
    }
}
