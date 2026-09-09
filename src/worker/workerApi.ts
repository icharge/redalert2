import { WaveFile } from "@ra2web/wavefile";
import type { SevenZipModuleOptions } from "7z-wasm";
import { VxlFile } from "@/data/VxlFile";
import type { PlainVxlFile } from "@/data/VxlFile";
import { ModelQuality } from "@/engine/renderable/entity/unit/ModelQuality";
import { VxlGeometryMonotoneBuilder } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryMonotoneBuilder";
import { BufferGeometrySerializer } from "@/engine/gfx/geometry/BufferGeometrySerializer";

export interface CompressFileEntry {
    name: string;
    data: Uint8Array | string;
}

export interface WorkerMethodMap {
    decodeWav: { args: [data: Uint8Array]; result: Uint8Array };
    generateVxlGeometry: { args: [plainVxl: PlainVxlFile, modelQuality: ModelQuality]; result: ArrayBuffer[] };
    compressFile: { args: [data: Uint8Array, filename: string]; result: Uint8Array };
    compressFiles: { args: [files: CompressFileEntry[]]; result: Uint8Array };
}

export type WorkerMethodName = keyof WorkerMethodMap;

export interface WorkerRequest {
    id: number;
    method: WorkerMethodName;
    args: unknown[];
}

export interface WorkerResponse {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
}

function decodeWav(data: Uint8Array): Uint8Array {
    const wav = new WaveFile();
    wav.fromBuffer(data as unknown as ArrayBuffer);
    if (wav.bitDepth === "4") {
        wav.fromIMAADPCM();
    }
    return new Uint8Array(wav.toBuffer());
}

function generateVxlGeometry(plainVxl: PlainVxlFile, _modelQuality: ModelQuality): ArrayBuffer[] {
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

async function compressFiles(files: CompressFileEntry[]): Promise<Uint8Array> {
    const SevenZip = (await import("7z-wasm")).default;
    // Same locateFile override GameResImporter.ts needs for this library: the
    // default locateFile can't resolve 7zz.wasm's URL from inside a module
    // worker, so it must be pointed at the copy served from public/7zz.wasm.
    const moduleOptions: Partial<SevenZipModuleOptions> & { noInitialRun?: boolean } = {
        noInitialRun: true,
        locateFile: (path: string) => (path === "7zz.wasm" ? "/7zz.wasm" : path),
    };
    const module = await SevenZip(moduleOptions);
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
    const exitCode = module.callMain(["a", "-t7z", "-mx=9", outputPath, ...inputPaths]) as unknown as number;
    if (exitCode !== 0) {
        throw new Error(`7z compression failed with exit code ${exitCode}`);
    }
    const output = module.FS.readFile(outputPath);
    return new Uint8Array(output);
}

async function compressFile(data: Uint8Array, filename: string): Promise<Uint8Array> {
    return compressFiles([{ name: filename, data }]);
}

const handlers: {
    [K in WorkerMethodName]: (
        ...args: WorkerMethodMap[K]["args"]
    ) => WorkerMethodMap[K]["result"] | Promise<WorkerMethodMap[K]["result"]>;
} = {
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
        response.result = await (handler as (...args: unknown[]) => unknown)(...args);
    }
    catch (error) {
        response.ok = false;
        response.error = (error as Error)?.message ?? String(error);
    }
    self.postMessage(response);
};
