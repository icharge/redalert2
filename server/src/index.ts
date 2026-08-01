import { server } from "./app.ts";
import { config } from "./config.ts";

await server.listen(config.port);
console.log(`[server] listening on ws://localhost:${config.port}`);
