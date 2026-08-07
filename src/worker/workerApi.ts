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

async function compressFile(data: Uint8Array, filename: string): Promise<Uint8Array> {
    const SevenZip = (await import("7z-wasm")).default as any;
    const module = await SevenZip({ noInitialRun: true } as any);
    const safeName = filename.split("/").pop() ?? "file";
    const inputPath = "/input_" + safeName;
    const outputPath = "/output.7z";
    module.FS.writeFile(inputPath, data);
    const exitCode = module.callMain(["a", "-t7z", "-mx=9", outputPath, inputPath]);
    if (exitCode !== 0) {
        throw new Error(`7z compression failed with exit code ${exitCode}`);
    }
    const output = module.FS.readFile(outputPath);
    return new Uint8Array(output);
}

const handlers: Record<string, (...args: any[]) => any> = {
    decodeWav,
    generateVxlGeometry,
    compressFile,
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
