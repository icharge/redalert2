import { Client } from '@colyseus/sdk';

export interface OnlineRoomMetadata {
    label: string;
    hostName: string;
    mapTitle: string;
    mapOfficial: boolean;
    gameModeLabel: string;
    maxSlots: number;
    passwordProtected: boolean;
}

export interface OnlineRoomListing {
    roomId: string;
    clients: number;
    maxClients: number;
    metadata: OnlineRoomMetadata;
}

function toHttpUrl(colyseusUrl: string): string {
    return colyseusUrl.replace(/^ws/, 'http');
}

export class ColyseusClient {
    private readonly client: Client;
    private readonly httpUrl: string;

    constructor(colyseusUrl: string) {
        this.client = new Client(colyseusUrl);
        this.httpUrl = toHttpUrl(colyseusUrl);
    }

    getClient(): Client {
        return this.client;
    }

    async listRooms(): Promise<OnlineRoomListing[]> {
        const response = await fetch(`${this.httpUrl}/rooms`);
        if (!response.ok) {
            throw new Error(`Failed to list online rooms: HTTP ${response.status}`);
        }
        return await response.json();
    }

    async getIceServers(): Promise<RTCIceServer[]> {
        const response = await fetch(`${this.httpUrl}/ice-servers`);
        if (!response.ok) {
            throw new Error(`Failed to fetch ICE server config: HTTP ${response.status}`);
        }
        const body = await response.json();
        return body.iceServers ?? [];
    }
}
