import { describe, test, expect } from 'bun:test';
import { RealFileSystemDir } from '@/data/vfs/RealFileSystemDir';
import { VirtualFile } from '@/data/vfs/VirtualFile';

// Chrome's File System Access API sends each FileSystemWritableFileStream
// write() as a single Mojo IPC message; writing a large extracted resource
// file (RA2's mix archives run into the hundreds of MB) in one write() call
// has been observed to kill the renderer with RESULT_CODE_KILLED_BAD_MESSAGE.
// RealFileSystemDir.writeFile() now chunks large writes — this locks down
// that every individual write() stays bounded and the file is still
// byte-for-byte correct once reassembled.
function makeFakeDirHandle() {
    const writeCalls: number[] = [];
    let writtenBytes: Uint8Array | undefined;
    let cursor = 0;
    const fileHandle = {
        async createWritable() {
            cursor = 0;
            writtenBytes = undefined;
            return {
                async write(chunk: Uint8Array) {
                    writeCalls.push(chunk.byteLength);
                    if (!writtenBytes) {
                        writtenBytes = new Uint8Array(chunk.byteLength);
                    }
                    else {
                        const grown = new Uint8Array(cursor + chunk.byteLength);
                        grown.set(writtenBytes);
                        writtenBytes = grown;
                    }
                    writtenBytes.set(chunk, cursor);
                    cursor += chunk.byteLength;
                },
                async close() { },
                async abort() { },
            };
        },
    };
    const dirHandle: any = {
        name: 'fake-root',
        async getFileHandle() {
            return fileHandle;
        },
        async removeEntry() {
            throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        },
    };
    return {
        dirHandle,
        writeCalls,
        getWrittenBytes: () => writtenBytes,
    };
}

describe('RealFileSystemDir.writeFile', () => {
    test('chunks a large write so no single write() call exceeds the safe size, and the bytes round-trip exactly', async () => {
        const { dirHandle, writeCalls, getWrittenBytes } = makeFakeDirHandle();
        const dir = new RealFileSystemDir(dirHandle, true);
        const size = 100 * 1024 * 1024 + 12345; // > 3 chunks at 32MB, uneven remainder
        const original = new Uint8Array(size);
        for (let i = 0; i < size; i += 4096) {
            original[i] = (i / 4096) % 256;
        }
        const virtualFile = VirtualFile.fromBytes(original, 'big.mix');

        await dir.writeFile(virtualFile);

        expect(writeCalls.length).toBeGreaterThan(1);
        for (const chunkSize of writeCalls) {
            expect(chunkSize).toBeLessThanOrEqual(32 * 1024 * 1024);
        }
        expect(writeCalls.reduce((a, b) => a + b, 0)).toBe(size);
        expect(getWrittenBytes()).toEqual(original);
    });

    test('a small file still writes correctly in a single call', async () => {
        const { dirHandle, writeCalls, getWrittenBytes } = makeFakeDirHandle();
        const dir = new RealFileSystemDir(dirHandle, true);
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const virtualFile = VirtualFile.fromBytes(original, 'small.txt');

        await dir.writeFile(virtualFile);

        expect(writeCalls).toEqual([5]);
        expect(getWrittenBytes()).toEqual(original);
    });
});
