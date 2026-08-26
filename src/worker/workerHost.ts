import type { CompressFileEntry, WorkerMethodMap, WorkerRequest, WorkerResponse } from "./workerApi";
import type { PlainVxlFile } from "@/data/VxlFile";
import type { ModelQuality } from "@/engine/renderable/entity/unit/ModelQuality";

const WORKER_COUNT = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

interface WorkerTask {
    run: (worker: WorkerHandle) => Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}

export class WorkerHandle {
    private worker: Worker;
    private nextId: number = 1;
    private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    constructor(worker: Worker) {
        this.worker = worker;
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleResponse(event.data);
        this.worker.onerror = (event) => {
            this.pending.forEach(({ reject }) => reject(new Error(event.message || "Worker error")));
            this.pending.clear();
        };
    }

    async decodeWav(data: Uint8Array): Promise<Uint8Array> {
        return this.call("decodeWav", [data]);
    }

    async generateVxlGeometry(plainVxl: PlainVxlFile, modelQuality: ModelQuality): Promise<ArrayBuffer[]> {
        return this.call("generateVxlGeometry", [plainVxl, modelQuality]);
    }

    async compressFile(data: Uint8Array, filename: string): Promise<Uint8Array> {
        return this.call("compressFile", [data, filename]);
    }

    async compressFiles(files: CompressFileEntry[]): Promise<Uint8Array> {
        return this.call("compressFiles", [files]);
    }

    private call<K extends keyof WorkerMethodMap>(
        method: K,
        args: WorkerMethodMap[K]["args"],
    ): Promise<WorkerMethodMap[K]["result"]> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value as WorkerMethodMap[K]["result"]),
                reject,
            });
            this.worker.postMessage({ id, method, args } satisfies WorkerRequest);
        });
    }

    private handleResponse(response: WorkerResponse): void {
        const pending = this.pending.get(response.id);
        if (!pending) {
            return;
        }
        this.pending.delete(response.id);
        if (response.ok) {
            pending.resolve(response.result);
        }
        else {
            pending.reject(new Error(response.error ?? "Worker error"));
        }
    }

    terminate(): void {
        this.worker.terminate();
        this.pending.forEach(({ reject }) => reject(new Error("Worker terminated")));
        this.pending.clear();
    }
}

export class WorkerHost {
    readonly concurrency: number = WORKER_COUNT;
    private pool: WorkerHandle[] = [];
    private queue: WorkerTask[] = [];
    private activeCount = 0;
    private disposed = false;

    constructor() {
    }

    warmUpPool(): void {
        if (this.disposed || this.pool.length > 0) {
            return;
        }
        for (let i = 0; i < this.concurrency; i++) {
            this.pool.push(this.createWorker());
        }
    }

    queueTask(task: (worker: WorkerHandle) => Promise<void>): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        this.warmUpPool();
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ run: task, resolve, reject });
            this.pump();
        });
    }

    async waitForTasks(): Promise<void> {
        while (this.queue.length > 0 || this.activeCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.queue = [];
        for (const worker of this.pool) {
            worker.terminate();
        }
        this.pool = [];
        this.activeCount = 0;
    }

    private createWorker(): WorkerHandle {
        const worker = new Worker(new URL("./workerApi.ts", import.meta.url), { type: "module" });
        return new WorkerHandle(worker);
    }

    private pump(): void {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift()!;
            const worker = this.pool[this.activeCount % this.pool.length];
            this.activeCount++;
            task.run(worker)
                .then(task.resolve, task.reject)
                .finally(() => {
                    this.activeCount--;
                    this.pump();
                });
        }
    }
}

export const workerHostApi: WorkerHost = new WorkerHost();
