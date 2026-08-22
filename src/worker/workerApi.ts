import { WaveFile } from "@ra2web/wavefile";
import { VxlFile } from "@/data/VxlFile";
import { VxlGeometryMonotoneBuilder } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryMonotoneBuilder";
import { BufferGeometrySerializer } from "@/engine/gfx/geometry/BufferGeometrySerializer";

interface WorkerRequest {
    id: number;
    method: string;
    args: any[];
}

interface WorkerResponse {
    id: number;
    ok: boolean;
    result?: any;
    error?: string;
}

function decodeWav(data: Uint8Array): Uint8Array {
    const wav = new WaveFile();
    wav.fromBuffer(data as any);
    if (wav.bitDepth === "4") {
        wav.fromIMAADPCM();
    }
    return new Uint8Array(wav.toBuffer() as any);
}

function generateVxlGeometry(plainVxl: any, _modelQuality: any): ArrayBuffer[] {
    const vxlFile = new VxlFile().fromPlain(plainVxl);
    const builder = new VxlGeometryMonotoneBuilder();
    const serializer = new BufferGeometrySerializer();
    const results: ArrayBuffer[] = [];
    for (const section of vxlFile.sections) {
        const geometry = builder.build(section);
        results.push(serializer.serialize(geometry));
        geometry.dispose();
    }
    return results;
}

async function compressFiles(files: { name: string; data: Uint8Array | string }[]): Promise<Uint8Array> {
    const SevenZip = (await import("7z-wasm")).default as any;
    // Same locateFile override GameResImporter.ts needs for this library: the
    // default locateFile can't resolve 7zz.wasm's URL from inside a module
    // worker, so it must be pointed at the copy served from public/7zz.wasm.
    const module = await SevenZip({
        noInitialRun: true,
        locateFile: (path: string) => path === "7zz.wasm" ? "/7zz.wasm" : path,
    } as any);
    // 7z stores each input's path exactly as given (minus the leading "/"),
    // so every entry is written straight to FS root under its own real
    // name -- a server extracting a known entry (e.g. "report.json", see
    // server/src/diagnostics/errorReportArchive.ts) needs that exact name
    // inside the archive, not some workspace-scoped rename. "__archive_
    // output.7z" is deliberately distinctive so it can't collide with any
    // real entry name a caller passes in.
    const outputPath = "/__archive_output.7z";
    const inputPaths = files.map((file) => {
        const safeName = file.name.split("/").pop() ?? "file";
        const inputPath = "/" + safeName;
        module.FS.writeFile(inputPath, file.data);
        return inputPath;
    });
    const exitCode = module.callMain(["a", "-t7z", "-mx=9", outputPath, ...inputPaths]);
    if (exitCode !== 0) {
        throw new Error(`7z compression failed with exit code ${exitCode}`);
    }
    const output = module.FS.readFile(outputPath);
    return new Uint8Array(output);
}

async function compressFile(data: Uint8Array, filename: string): Promise<Uint8Array> {
    return compressFiles([{ name: filename, data }]);
}

const handlers: Record<string, (...args: any[]) => any> = {
    decodeWav,
    generateVxlGeometry,
    compressFile,
    compressFiles,
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const { id, method, args } = event.data;
    const response: WorkerResponse = { id, ok: true };
    try {
        const handler = handlers[method];
        if (!handler) {
            throw new Error(`Unknown worker method "${method}"`);
        }
        response.result = await handler(...args);
    }
    catch (error) {
        response.ok = false;
        response.error = (error as Error)?.message ?? String(error);
    }
    (self as any).postMessage(response);
};
