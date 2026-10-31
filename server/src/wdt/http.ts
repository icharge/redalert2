// HTTP surface for the WDT state, used by the browser bridge and the admin
// console. The browser cannot open the native TCP endpoint, so it fetches the
// same packet here over the origin it already reaches.

import { WdtService } from "./service";
import { WdtError } from "./types";

function queryCycle(url: URL): "current" | "previous" {
    return url.searchParams.get("cycle") === "previous" ? "previous" : "current";
}

/** Returns a response for /wdt/*, or undefined for another path. */
export function handleWdt(req: Request, service: WdtService): Response | undefined {
    const url = new URL(req.url);
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
        } catch (error) {
            const reason = error instanceof WdtError ? error.message : "unavailable";
            return new Response(reason, { status: 404 });
        }
    }
    if (url.pathname === "/wdt/status") {
        if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return Response.json(service.summary());
    }
    return undefined;
}
