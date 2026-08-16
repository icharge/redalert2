import { DataStream } from "@/data/DataStream";
import { ObjectType } from "@/engine/type/ObjectType";
import { OBS_COUNTRY_ID } from "@/game/gameopts/constants";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import { GameResType } from "@/network/gameres/GameResType";
import type { GameResGameInfo } from "@/network/gameres/GameResGameInfo";
import type { GameResClientInfo } from "@/network/gameres/GameResClientInfo";
import type { GameResPlayerInfo } from "@/network/gameres/GameResPlayerInfo";
import type { GameResAiPlayerInfo } from "@/network/gameres/GameResAiPlayerInfo";

enum FieldType {
    Byte = 1,
    Boolean = 2,
    Time = 5,
    Int = 6,
    String = 7,
}

type FlatValue = [FieldType, any];

export class GameRes {
    public game!: GameResGameInfo;
    public client!: GameResClientInfo;
    public players: GameResPlayerInfo[] = [];
    public aiPlayers: GameResAiPlayerInfo[] = [];

    fromGame(game: any, tournament: boolean, clientInfo: GameResClientInfo): GameRes {
        const gameOpts = game.gameOpts;
        const humanPlayers = gameOpts.humanPlayers
            .filter((player: any) => player.countryId !== OBS_COUNTRY_ID)
            .map((player: any) => game.getPlayerByName(player.name));
        const aiPlayers = game.getNonNeutralPlayers().filter((player: any) => player.isAi);
        const allPlayers = [...humanPlayers, ...aiPlayers];
        this.game = {
            id: game.id,
            startTime: game.startTimestamp,
            duration: Math.floor(game.currentTime / 1000),
            speed: 6 - gameOpts.gameSpeed,
            players: humanPlayers.length,
            mapName: gameOpts.mapName,
            mapDigest: gameOpts.mapDigest,
            unitCount: gameOpts.unitCount,
            cratesAppear: gameOpts.cratesAppear,
            credits: gameOpts.credits,
            tournament,
            shortGame: gameOpts.shortGame,
            superWeapons: gameOpts.superWeapons,
            aiPlayers: gameOpts.aiPlayers.filter(isNotNullOrUndefined).length,
            gameMode: gameOpts.gameMode,
            buildOffAlly: gameOpts.buildOffAlly,
            mcvRepacks: gameOpts.mcvRepacks,
            destroyableBridges: gameOpts.destroyableBridges,
            multiEngineer: gameOpts.multiEngineer,
            noDogEngiKills: gameOpts.noDogEngiKills,
            instantCapture: gameOpts.instantCapture,
            delayedOils: gameOpts.delayedOils,
        };
        this.client = clientInfo;
        const playerTeams = this.computePlayerTeams(game, allPlayers);
        this.players = humanPlayers.map(player => this.createPlayerInfo(player, game, clientInfo, allPlayers, playerTeams));
        this.aiPlayers = aiPlayers.map(player => this.createAiPlayerInfo(player, game, clientInfo, allPlayers, playerTeams));
        return this;
    }

    private createPlayerInfo(player: any, game: any, clientInfo: GameResClientInfo, allPlayers: any[], playerTeams: Map<any, number>): GameResPlayerInfo {
        return {
            buildingsBuilt: player.getUnitsBuilt(ObjectType.Building),
            buildingsCaptured: player.buildingsCaptured,
            buildingsKilled: player.getUnitsKilled(ObjectType.Building),
            buildingsLeft: player.buildings.size,
            color: [...game.rules.getMultiplayerColors().values()].findIndex((color: any) => color.asHex() === player.color.asHex()),
            cratesFound: player.cratesPickedUp,
            endCredits: player.credits,
            creditsGained: player.creditsGained,
            infantryBuilt: player.getUnitsBuilt(ObjectType.Infantry),
            infantryKilled: player.getUnitsKilled(ObjectType.Infantry),
            infantryLeft: player.getOwnedObjectsByType(ObjectType.Infantry).length,
            lostConnection: player.name === clientInfo.accountName && clientInfo.suddenDisconnect,
            name: player.name,
            planesBuilt: player.getUnitsBuilt(ObjectType.Aircraft),
            planesKilled: player.getUnitsKilled(ObjectType.Aircraft),
            planesLeft: player.getOwnedObjectsByType(ObjectType.Aircraft).length,
            unitsBuilt: player.getUnitsBuilt(ObjectType.Vehicle),
            unitsKilled: player.getUnitsKilled(ObjectType.Vehicle),
            unitsLeft: player.getOwnedObjectsByType(ObjectType.Vehicle).length,
            completionStatus: this.getCompletionStatus(player, game, clientInfo, allPlayers),
            country: player.country.id,
            side: player.country.side,
            team: playerTeams.get(player)!,
            startPos: player.startLocation,
        };
    }

    private createAiPlayerInfo(player: any, game: any, clientInfo: GameResClientInfo, allPlayers: any[], playerTeams: Map<any, number>): GameResAiPlayerInfo {
        if (player.aiDifficulty === undefined) {
            throw new Error(`AI player "${player.name}" is missing difficulty`);
        }
        return {
            ...this.createPlayerInfo(player, game, clientInfo, allPlayers, playerTeams),
            difficulty: player.aiDifficulty,
        };
    }

    private computePlayerTeams(game: any, players: any[]): Map<any, number> {
        const teams = new Map<any, number>();
        let nextTeamId = 0;
        for (const player of players) {
            if (!teams.has(player)) {
                teams.set(player, nextTeamId);
                for (const ally of game.alliances.getAllies(player)) {
                    if (!teams.has(ally)) {
                        teams.set(ally, nextTeamId);
                    }
                }
                nextTeamId++;
            }
        }
        return teams;
    }

    private getCompletionStatus(player: any, game: any, clientInfo: GameResClientInfo, allPlayers: any[]): GameResType {
        const hasUndefeatedAlly = game.alliances.getAllies(player).some((ally: any) => !ally.defeated);
        if (clientInfo.finished) {
            if (game.stalemateDetectTrait?.isStale() && game.stalemateDetectTrait.getCountdownTicks() === 0) {
                if (!game.alliances.getAllies(player).length) {
                    if (player.resigned) {
                        return GameResType.Resign;
                    }
                    if (player.dropped) {
                        return GameResType.Disconnect;
                    }
                }
                return GameResType.Draw;
            }
            return !player.defeated || hasUndefeatedAlly
                ? GameResType.Win
                : player.resigned
                    ? GameResType.Resign
                    : player.dropped
                        ? GameResType.Disconnect
                        : GameResType.Loss;
        }
        if (clientInfo.outOfSync) {
            return GameResType.Playing;
        }
        if (!allPlayers.some((p: any) => p.name === clientInfo.accountName)) {
            return GameResType.Playing;
        }
        if (clientInfo.accountName === player.name) {
            return clientInfo.quit
                ? GameResType.Resign
                : player.defeated
                    ? GameResType.Loss
                    : GameResType.Disconnect;
        }
        if (allPlayers.length === 2) {
            return GameResType.Win;
        }
        if (!hasUndefeatedAlly) {
            if (player.resigned) {
                return GameResType.Resign;
            }
            if (player.dropped) {
                return GameResType.Disconnect;
            }
            if (player.defeated) {
                return GameResType.Loss;
            }
        }
        return GameResType.Playing;
    }

    toFlat(): Record<string, FlatValue> {
        const playerData = this.toFlatPlayerData(this.players, this.aiPlayers);
        return {
            AFPS: [FieldType.Int, this.client.avgFps],
            APNG: [FieldType.Int, this.client.avgRtt],
            AIPL: [FieldType.Int, this.game.aiPlayers],
            CRAT: [FieldType.Boolean, this.game.cratesAppear],
            DURA: [FieldType.Int, this.game.duration],
            FINI: [FieldType.Boolean, this.client.finished],
            GSKU: [FieldType.Int, this.client.gameSku],
            CRED: [FieldType.Int, this.game.credits],
            OOSY: [FieldType.Boolean, this.client.outOfSync],
            PLRS: [FieldType.Int, this.game.players],
            PNGR: [FieldType.Int, this.client.pingsRecv],
            PNGS: [FieldType.Int, this.client.pingsSent],
            SCEN: [FieldType.String, this.game.mapName],
            SHRT: [FieldType.Boolean, this.game.shortGame],
            SPED: [FieldType.Int, this.game.speed],
            SUPR: [FieldType.Boolean, this.game.superWeapons],
            TIME: [FieldType.Time, this.game.startTime],
            TRNY: [FieldType.Boolean, this.game.tournament],
            UNIT: [FieldType.Int, this.game.unitCount],
            VERS: [FieldType.String, this.client.clientVers],
            MODE: [FieldType.Int, this.game.gameMode],
            BAMR: [FieldType.Int, Number(this.game.mcvRepacks) + 2 * Number(this.game.buildOffAlly)],
            MAPC: [FieldType.String, this.game.mapDigest],
            GMID: [FieldType.String, this.game.id],
            SNAM: [FieldType.String, this.client.accountName],
            DSTB: [FieldType.Boolean, this.game.destroyableBridges],
            MENG: [FieldType.Boolean, this.game.multiEngineer],
            DOGK: [FieldType.Boolean, this.game.noDogEngiKills],
            ICAP: [FieldType.Boolean, this.game.instantCapture],
            DOIL: [FieldType.Boolean, this.game.delayedOils],
            ...playerData,
        };
    }

    private toFlatPlayerData(players: GameResPlayerInfo[], aiPlayers: GameResAiPlayerInfo[]): Record<string, FlatValue> {
        const entries: Record<string, FlatValue> = {};
        [...players, ...aiPlayers].forEach((player, index) => {
            Object.assign(entries, {
                ["BLB" + index]: [FieldType.Time, player.buildingsBuilt],
                ["BLC" + index]: [FieldType.Int, player.buildingsCaptured],
                ["BLK" + index]: [FieldType.Time, player.buildingsKilled],
                ["BLL" + index]: [FieldType.Time, player.buildingsLeft],
                ["COL" + index]: [FieldType.Int, player.color],
                ["CRA" + index]: [FieldType.Int, player.cratesFound],
                ["CRD" + index]: [FieldType.Time, player.endCredits],
                ["HRV" + index]: [FieldType.Int, player.creditsGained],
                ["INB" + index]: [FieldType.Time, player.infantryBuilt],
                ["INK" + index]: [FieldType.Time, player.infantryKilled],
                ["INL" + index]: [FieldType.Time, player.infantryLeft],
                ["LCN" + index]: [FieldType.Boolean, player.lostConnection],
                ["NAM" + index]: [FieldType.String, player.name],
                ["PLB" + index]: [FieldType.Time, player.planesBuilt],
                ["PLK" + index]: [FieldType.Time, player.planesKilled],
                ["PLL" + index]: [FieldType.Time, player.planesLeft],
                ["UNB" + index]: [FieldType.Time, player.unitsBuilt],
                ["UNK" + index]: [FieldType.Time, player.unitsKilled],
                ["UNL" + index]: [FieldType.Time, player.unitsLeft],
                ["CMP" + index]: [FieldType.Int, player.completionStatus],
                ["CTY" + index]: [FieldType.Int, player.country],
                ["SID" + index]: [FieldType.Int, player.side],
                ["TID" + index]: [FieldType.Int, player.team],
                ["STP" + index]: [FieldType.Int, player.startPos],
                ...(index >= players.length ? {
                    ["AID" + index]: [FieldType.Int, (player as GameResAiPlayerInfo).difficulty],
                } : {}),
            });
        });
        return entries;
    }

    fromFlat(flat: Record<string, FlatValue>): void {
        const toInt = (value?: FlatValue): number => value && (value[0] === FieldType.Int || value[0] === FieldType.Time) ? value[1] : 0;
        const toBool = (value?: FlatValue): boolean => !!value && value[0] === FieldType.Boolean && value[1];
        const toString = (value?: FlatValue): string => value && value[0] === FieldType.String ? value[1] : "";
        const playerCount = toInt(flat.PLRS);
        const aiCount = toInt(flat.AIPL);
        const bitmask = toInt(flat.BAMR);
        const buildOffAlly = Boolean(bitmask & 2);
        const mcvRepacks = Boolean(bitmask & 1);
        this.game = {
            aiPlayers: aiCount,
            cratesAppear: toBool(flat.CRAT),
            duration: toInt(flat.DURA),
            credits: toInt(flat.CRED),
            id: toString(flat.GMID),
            players: playerCount,
            mapName: toString(flat.SCEN),
            shortGame: toBool(flat.SHRT),
            speed: toInt(flat.SPED),
            superWeapons: toBool(flat.SUPR),
            startTime: toInt(flat.TIME),
            tournament: toBool(flat.TRNY),
            unitCount: toInt(flat.UNIT),
            gameMode: toInt(flat.MODE),
            buildOffAlly,
            mcvRepacks,
            mapDigest: toString(flat.MAPC),
            destroyableBridges: flat.DSTB === undefined || toBool(flat.DSTB),
            multiEngineer: flat.MENG !== undefined && toBool(flat.MENG),
            noDogEngiKills: flat.DOGK !== undefined && toBool(flat.DOGK),
            instantCapture: flat.ICAP === undefined || toBool(flat.ICAP),
            delayedOils: flat.DOIL !== undefined && toBool(flat.DOIL),
        };
        const parsePlayer = (index: number): GameResPlayerInfo => ({
            buildingsBuilt: toInt(flat["BLB" + index]),
            buildingsCaptured: toInt(flat["BLC" + index]),
            buildingsKilled: toInt(flat["BLK" + index]),
            buildingsLeft: toInt(flat["BLL" + index]),
            color: toInt(flat["COL" + index]),
            cratesFound: toInt(flat["CRA" + index]),
            endCredits: toInt(flat["CRD" + index]),
            creditsGained: flat["HRV" + index] !== undefined ? toInt(flat["HRV" + index]) : -1,
            infantryBuilt: toInt(flat["INB" + index]),
            infantryKilled: toInt(flat["INK" + index]),
            infantryLeft: toInt(flat["INL" + index]),
            lostConnection: toBool(flat["LCN" + index]),
            name: toString(flat["NAM" + index]),
            planesBuilt: toInt(flat["PLB" + index]),
            planesKilled: toInt(flat["PLK" + index]),
            planesLeft: toInt(flat["PLL" + index]),
            unitsBuilt: toInt(flat["UNB" + index]),
            unitsKilled: toInt(flat["UNK" + index]),
            unitsLeft: toInt(flat["UNL" + index]),
            completionStatus: toInt(flat["CMP" + index]),
            country: toInt(flat["CTY" + index]),
            side: toInt(flat["SID" + index]),
            team: toInt(flat["TID" + index]),
            startPos: flat["STP" + index] !== undefined ? toInt(flat["STP" + index]) : -1,
        });
        this.players = new Array(playerCount).fill(0).map((_, index) => parsePlayer(index));
        this.aiPlayers = new Array(aiCount).fill(0).map((_, index) => playerCount + index)
            .filter(index => flat["NAM" + index] !== undefined)
            .map((index) => {
                const difficultyField = flat["AID" + index];
                if (!difficultyField) {
                    throw new Error("Game res packet is missing AI difficulty field AID" + index);
                }
                return {
                    ...parsePlayer(index),
                    difficulty: toInt(difficultyField),
                };
            });
        const accountName = toString(flat.SNAM);
        const accountPlayer = this.players.find(player => player.name === accountName);
        this.client = {
            avgFps: toInt(flat.AFPS),
            avgRtt: toInt(flat.APNG),
            finished: toBool(flat.FINI),
            gameSku: toInt(flat.GSKU),
            outOfSync: toBool(flat.OOSY),
            pingsRecv: toInt(flat.PNGR),
            pingsSent: toInt(flat.PNGS),
            clientVers: toString(flat.VERS),
            quit: accountPlayer?.completionStatus === GameResType.Resign,
            accountName,
            suddenDisconnect: accountPlayer?.lostConnection ?? false,
        };
    }

    toBinary(): Uint8Array {
        const stream = new DataStream();
        const flat = this.toFlat();
        for (const fieldName of Object.keys(flat)) {
            const [type, value] = flat[fieldName];
            this.writeType(type, fieldName, value, stream);
        }
        const header = new DataStream();
        header.writeUint16(stream.byteLength + 4, DataStream.BIG_ENDIAN);
        header.writeUint16(0);
        header.writeUint8Array(new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength));
        return new Uint8Array(header.buffer, header.byteOffset, header.byteLength);
    }

    fromBinary(data: Uint8Array): GameRes {
        const stream = new DataStream(data);
        const bodyLength = stream.readUint16(DataStream.BIG_ENDIAN) - 4;
        if (stream.readUint16() !== 0) {
            throw new Error("Invalid game res packet. Second byte should be 0.");
        }
        const flat: Record<string, FlatValue> = {};
        while (bodyLength && stream.position <= bodyLength - 4) {
            const { fieldName, type, data: value } = this.readType(stream);
            if (value !== undefined) {
                flat[fieldName] = [type, value];
            }
        }
        this.fromFlat(flat);
        return this;
    }

    private writeType(type: FieldType, fieldName: string, value: any, stream: DataStream): void {
        if (fieldName.length > 4) {
            throw new Error(`Field "${fieldName}" must not exceed 4 characters`);
        }
        stream.writeString(fieldName, "ASCII", 4);
        stream.writeUint16(type, DataStream.BIG_ENDIAN);
        switch (type) {
            case FieldType.Byte:
                stream.writeUint16(1, DataStream.BIG_ENDIAN);
                stream.writeUint32(value as number, DataStream.BIG_ENDIAN);
                return;
            case FieldType.Boolean:
                stream.writeUint16(1, DataStream.BIG_ENDIAN);
                stream.writeUint8Array(new Uint8Array([value ? 1 : 0, 0, 0, 0]));
                return;
            case FieldType.Time:
            case FieldType.Int:
                stream.writeUint16(4, DataStream.BIG_ENDIAN);
                stream.writeUint32(value as number, DataStream.BIG_ENDIAN);
                return;
            case FieldType.String: {
                const length = value.length + 1;
                const paddedLength = 4 * Math.ceil(length / 4);
                stream.writeUint16(length, DataStream.BIG_ENDIAN);
                stream.writeCString(value);
                stream.writeUint8Array(new Uint8Array(paddedLength - length));
                return;
            }
            default:
                throw new Error(`Unhandled type "${type}"`);
        }
    }

    private readType(stream: DataStream): { fieldName: string; type: FieldType; data: any } {
        const fieldName = stream.readString(4, "ASCII");
        const type = stream.readUint16(DataStream.BIG_ENDIAN);
        const length = stream.readUint16(DataStream.BIG_ENDIAN);
        let data: any;
        switch (type) {
            case FieldType.Byte:
                data = stream.readUint32(DataStream.BIG_ENDIAN);
                break;
            case FieldType.Boolean:
                data = Boolean(stream.readUint8Array(4)[0]);
                break;
            case FieldType.Time:
            case FieldType.Int:
                data = stream.readUint32(DataStream.BIG_ENDIAN);
                break;
            case FieldType.String:
                data = stream.readCString(4 * Math.ceil(length / 4));
                break;
            default:
                console.warn(`Unknown game res field type "${type}"`);
                stream.position += length;
                data = undefined;
        }
        return {
            fieldName,
            type,
            data,
        };
    }
}
