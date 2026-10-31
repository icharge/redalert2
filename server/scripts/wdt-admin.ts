/**
 * Live check of the WDT operator routes and SQLite persistence.
 *
 *   SERVER_URL=http://127.0.0.1:19093 bun run scripts/wdt-admin.ts before
 *   # restart the server with the same DB_PATH
 *   SERVER_URL=http://127.0.0.1:19093 bun run scripts/wdt-admin.ts after
 *
 * `before` asserts 401 without a token, then rollover/disable/enable/reset and
 * prints the resulting cycle id. `after` only reads /wdt/status and expects the
 * same cycle id, proving the snapshot survived the restart.
 */
import { registerOrLogin } from "./wolLib";

const base = process.env.SERVER_URL ?? "http://127.0.0.1:19093";
const phase = process.argv[2] ?? "before";
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
    if (ok) console.log(`  [ok]   ${name}`);
    else { failures += 1; console.log(`  [FAIL] ${name}${detail ? ` :: ${detail}` : ""}`); }
}

const status = await (await fetch(`${base}/wdt/status`)).json() as { cycle: { id: number }; enabled: boolean };
if (phase === "after") {
    const expected = Number(process.env.WDT_EXPECT_CYCLE ?? 0);
    check("cycle id survived the restart", status.cycle.id === expected, `${status.cycle.id} != ${expected}`);
    check("enabled flag survived the restart", status.enabled === true, String(status.enabled));
    console.log(failures === 0 ? "\nWDT ADMIN PERSISTENCE PASSED" : `\nWDT ADMIN PERSISTENCE FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
}

const token = await registerOrLogin(base, "wdtadmin", "password123");
const call = (path: string, body?: unknown, auth = true) => fetch(`${base}${path}`, {
    method: "POST",
    headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

check("unauthenticated rollover is rejected", (await call("/wdt/admin/rollover", undefined, false)).status === 401);
const roll = await call("/wdt/admin/rollover");
const rollBody = await roll.json() as { cycle: { id: number } };
check("rollover advances the cycle", roll.status === 200 && rollBody.cycle.id >= 2, JSON.stringify(rollBody));

const disabled = await call("/wdt/admin/enable", { enabled: false });
check("disable is applied", (await disabled.json() as { enabled: boolean }).enabled === false);
check("disabled state returns 503", (await fetch(`${base}/wdt/state`)).status === 503);
const enabled = await call("/wdt/admin/enable", { enabled: true });
check("enable is applied", (await enabled.json() as { enabled: boolean }).enabled === true);
check("state returns 200 again", (await fetch(`${base}/wdt/state`)).status === 200);

const reset = await call("/wdt/admin/reset");
const resetBody = await reset.json() as { cycle: { id: number } };
check("reset starts a fresh cycle", reset.status === 200 && resetBody.cycle.id > rollBody.cycle.id, JSON.stringify(resetBody));
const adminStatus = await (await fetch(`${base}/wdt/admin/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { cycle: { id: number } };
check("admin status sees the reset cycle", adminStatus.cycle.id === resetBody.cycle.id, JSON.stringify(adminStatus));

console.log(`  cycle id for the restart check: ${resetBody.cycle.id}`);
console.log(failures === 0 ? "\nWDT ADMIN TEST PASSED" : `\nWDT ADMIN TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
