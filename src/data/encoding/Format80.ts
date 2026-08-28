import { DataStream } from '../DataStream';
export class Format80 {
    static decode(input: Uint8Array, outputSize: number): Uint8Array {
        const output = new Uint8Array(outputSize);
        this.decodeInto(input, output);
        return output;
    }
    static decodeInto(input: Uint8Array, output: Uint8Array): number {
        const stream = new DataStream(new DataView(input.buffer, input.byteOffset, input.byteLength));
        let outputPos = 0;
        while (true) {
            const cmd = stream.readUint8();
            if ((cmd & 128) === 0) {
                const byte = stream.readUint8();
                const count = 3 + ((cmd & 112) >> 4);
                this.replicatePrevious(output, outputPos, outputPos - (((cmd & 15) << 8) + byte), count);
                outputPos += count;
            }
            else if ((cmd & 64) === 0) {
                const count = cmd & 63;
                if (count === 0)
                    return outputPos;
                output.set(stream.readUint8Array(count), outputPos);
                outputPos += count;
            }
            else {
                const count = cmd & 63;
                if (count === 62) {
                    const length = stream.readInt16();
                    const value = stream.readUint8();
                    const end = outputPos + length;
                    while (outputPos < end) {
                        output[outputPos++] = value;
                    }
                }
                else if (count === 63) {
                    const length = stream.readInt16();
                    let srcIndex = stream.readInt16();
                    if (srcIndex >= outputPos) {
                        throw new Error(`srcIndex >= destIndex ${srcIndex} ${outputPos}`);
                    }
                    const end = outputPos + length;
                    while (outputPos < end) {
                        output[outputPos++] = output[srcIndex++];
                    }
                }
                else {
                    const count2 = 3 + count;
                    let srcIndex = stream.readInt16();
                    if (srcIndex >= outputPos) {
                        throw new Error(`srcIndex >= destIndex ${srcIndex} ${outputPos}`);
                    }
                    const end = outputPos + count2;
                    while (outputPos < end) {
                        output[outputPos++] = output[srcIndex++];
                    }
                }
            }
        }
    }
    private static replicatePrevious(output: Uint8Array, destIndex: number, srcIndex: number, count: number): void {
        if (destIndex < srcIndex) {
            throw new Error(`srcIndex > destIndex ${srcIndex} ${destIndex}`);
        }
        if (destIndex - srcIndex === 1) {
            for (let i = 0; i < count; i++) {
                output[destIndex + i] = output[destIndex - 1];
            }
        }
        else {
            for (let i = 0; i < count; i++) {
                output[destIndex + i] = output[srcIndex + i];
            }
        }
    }
    // Ported from OpenRA's LCWCompression.Encode (GPL-3.0-or-later) - a
    // deliberately simple "quick and dirty" encoder using only literal-copy
    // blocks (cmd 0x80|count) and run-length byte-repeat commands (cmd
    // 0xFE), never the back-reference copy commands. That's fine: the
    // format only needs to be valid, not optimal, and repeated single-byte
    // runs (common in overlay data - most tiles have no overlay) already
    // compress well this way.
    //
    // One deviation from OpenRA's version: their RLE run length caps at
    // 0xFFFF (65535), written as a plain little-endian word. Our decodeInto
    // reads that length with DataStream.readInt16 (signed), so any run
    // length above 32767 would read back negative and corrupt the decode.
    // Cap at 0x7FFF instead; a longer run just splits into more than one
    // consecutive RLE command, which decodes to the same result.
    static encode(input: Uint8Array): Uint8Array {
        const MAX_RUN = 0x7FFF;
        const output: number[] = [];
        const writeCopyBlocks = (from: number, count: number): void => {
            let remaining = count;
            let pos = from;
            while (remaining > 0) {
                const writeNow = Math.min(remaining, 0x3F);
                output.push(0x80 | writeNow);
                for (let i = 0; i < writeNow; i++) {
                    output.push(input[pos + i]);
                }
                remaining -= writeNow;
                pos += writeNow;
            }
        };
        let offset = 0;
        let blockStart = 0;
        while (offset < input.length) {
            const repeatCount = this.countSame(input, offset, MAX_RUN);
            if (repeatCount >= 4) {
                writeCopyBlocks(blockStart, offset - blockStart);
                output.push(0xFE, repeatCount & 0xFF, (repeatCount >> 8) & 0xFF, input[offset]);
                offset += repeatCount;
                blockStart = offset;
            }
            else {
                offset++;
            }
        }
        writeCopyBlocks(blockStart, offset - blockStart);
        output.push(0x80);
        return Uint8Array.from(output);
    }
    private static countSame(input: Uint8Array, offset: number, maxCount: number): number {
        const limit = Math.min(input.length - offset, maxCount);
        if (limit <= 0) {
            return 0;
        }
        const first = input[offset];
        let count = 1;
        while (count < limit && input[offset + count] === first) {
            count++;
        }
        return count;
    }
}
