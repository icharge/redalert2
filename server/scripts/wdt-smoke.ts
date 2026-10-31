// End-to-end check of the running WDT endpoints: HTTP state for the browser
// bridge and the native TCP listener, decoded with the same codec the client
// parser mirrors.
import { decodeContainer, readU32 } from "../src/wdt/codec";

const base = process.env.WDT_SERVER_URL ?? "http://127.0.0.1:19091";
const tcpPort = Number(process.env.WDT_TCP_PORT ?? 29091);

const http = await fetch(`${base}/wdt/state?cycle=current`);
const body = Buffer.from(await http.arrayBuffer());
console.log("http", http.status, http.headers.get("content-type"), body.length, "bytes");
const records = decodeContainer(body);
console.log("tags", [...records.keys()].join(","));
console.log("CRTK", readU32(records, "CRTK"), "TICC", readU32(records, "TICC"),
    "MPVC", records.get("MPVC")?.length, "HSVC", records.get("HSVC")?.length);

const tcp = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    Bun.connect({
        hostname: "127.0.0.1",
        port: tcpPort,
        socket: {
            open(socket) { socket.write("WDT PREVIOUS\n"); },
            data(_socket, data) { chunks.push(Buffer.from(data)); },
            close() { resolve(Buffer.concat(chunks)); },
            error(_socket, error) { reject(error); },
        },
    });
    setTimeout(() => reject(new Error("tcp timeout")), 3000);
});
const previous = decodeContainer(tcp);
console.log("tcp", tcp.length, "bytes", [...previous.keys()].join(","),
    "TOTK", readU32(previous, "TOTK"));
