import { Format80 } from './Format80';
import { MiniLzo } from './MiniLzo';
export class Format5 {
    // Matches the chunk size the real game's encoder uses (and this file's
    // own decodeInto has no opinion on - it just reads whatever size each
    // chunk header declares), confirmed against CMapData::CompressLCWData /
    // FinalSun's own writer: 8192 bytes of decompressed input per chunk.
    static readonly CHUNK_SIZE = 8192;
    static encode(input: Uint8Array, format: number = 5): Uint8Array {
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        for (let offset = 0; offset < input.length; offset += this.CHUNK_SIZE) {
            const chunk = input.subarray(offset, Math.min(offset + this.CHUNK_SIZE, input.length));
            const compressed = format === 80 ? Format80.encode(chunk) : MiniLzo.compress(chunk);
            const header = new Uint8Array(4);
            const headerView = new DataView(header.buffer);
            headerView.setUint16(0, compressed.length, true);
            headerView.setUint16(2, chunk.length, true);
            chunks.push(header, compressed);
            totalSize += header.length + compressed.length;
        }
        const output = new Uint8Array(totalSize);
        let pos = 0;
        for (const chunk of chunks) {
            output.set(chunk, pos);
            pos += chunk.length;
        }
        return output;
    }
    static decode(input: Uint8Array, outputSize: number, format: number = 5): Uint8Array {
        const output = new Uint8Array(outputSize);
        this.decodeInto(input, output, format);
        return output;
    }
    static decodeInto(input: Uint8Array, output: Uint8Array, format: number = 5): void {
        const outputLength = output.length;
        let inputPos = 0;
        let outputPos = 0;
        while (outputPos < outputLength) {
            const compressedSize = (input[inputPos + 1] << 8) | input[inputPos];
            inputPos += 2;
            const decompressedSize = (input[inputPos + 1] << 8) | input[inputPos];
            inputPos += 2;
            if (!compressedSize || !decompressedSize)
                break;
            let decompressed: Uint8Array;
            if (format === 80) {
                decompressed = Format80.decode(input.subarray(inputPos, inputPos + compressedSize), decompressedSize);
            }
            else {
                decompressed = MiniLzo.decompress(input.subarray(inputPos, inputPos + compressedSize), decompressedSize);
            }
            for (let i = 0; i < decompressedSize; ++i) {
                output[outputPos + i] = decompressed[i];
            }
            inputPos += compressedSize;
            outputPos += decompressedSize;
        }
    }
}
