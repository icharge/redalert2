export interface SocketLike {
    readyState: number;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
}

export const OPEN_STATE = 1;
