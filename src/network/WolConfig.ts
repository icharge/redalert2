import { LadderQueueType } from "@/network/ladder/wladderConfig";

export const GLOBAL_CHANNEL_PASS = "zotclot9";
export const MATCH_BOT_NAME = "matchbot";
export const MIN_USERNAME_LEN = 2;
export const MAX_USERNAME_LEN = 15;
export const MIN_PASS_LEN = 8;
export const MAX_PASS_LEN = 128;
export const MAX_MAP_TRANSFER_BYTES = 2 * 1024 * 1024;

export enum ClientType {
    Cdral2 = 0,
    Cdyuri = 1,
}

interface ClientSettings {
    sku: number;
    channelType: number;
    qmChanIds: Map<LadderQueueType, number>;
}

export class WolConfig {
    private clientSettings: ClientSettings;

    constructor(private clientType: ClientType, clientSettings: ClientSettings) {
        this.clientSettings = clientSettings;
    }

    static skuToClientType(sku: number): ClientType | undefined {
        return [...WolConfig.allClientSettings.entries()].find(([, settings]) => settings.sku === sku)?.[0];
    }

    static channelTypeToClientType(channelType: number): ClientType | undefined {
        return [...WolConfig.allClientSettings.entries()].find(([, settings]) => settings.channelType === channelType)?.[0];
    }

    static factory(clientType: ClientType): WolConfig {
        const clientSettings = WolConfig.allClientSettings.get(clientType);
        if (!clientSettings) {
            throw new Error(`Unhandled client type "${ClientType[clientType]}"`);
        }
        return new this(clientType, clientSettings);
    }

    getClientSku(): number {
        return this.clientSettings.sku;
    }

    getClientChannelType(): number {
        return this.clientSettings.channelType;
    }

    getGlobalChannelPass(): string {
        return GLOBAL_CHANNEL_PASS;
    }

    getQuickMatchBotName(): string {
        return MATCH_BOT_NAME;
    }

    getAllQuickMatchChannelIds(): number[] {
        return [...this.clientSettings.qmChanIds.values()];
    }

    getQuickMatchChannelId(queueType: LadderQueueType): number {
        const channelId = this.clientSettings.qmChanIds.get(queueType);
        if (channelId === undefined) {
            throw new Error(`Client type ${this.clientType} doesn't have a configured channel for ladder=${queueType}`);
        }
        return channelId;
    }

    static allClientSettings = new Map<ClientType, ClientSettings>([
        [ClientType.Cdral2, {
            sku: 16640,
            channelType: 45,
            qmChanIds: new Map([
                [LadderQueueType.Solo1v1, 50],
                [LadderQueueType.Team2v2, 51],
            ]),
        }],
        [ClientType.Cdyuri, {
            sku: 18688,
            channelType: 55,
            qmChanIds: new Map([
                [LadderQueueType.Solo1v1, 60],
                [LadderQueueType.Team2v2, 61],
            ]),
        }],
    ]);
}
