import { Serializer } from '@/network/gameopt/Serializer';
import { Parser } from '@/network/gameopt/Parser';
import { Base64 } from '@/util/Base64';
import { ReplayEventFactory } from '@/network/gamestate/replay/ReplayEventFactory';
import { makeTextFileLineIterator } from '@/util/stream';
import { utf16ToBinaryString, binaryStringToUtf16 } from '@/util/string';

const supportedReplayVersions = [5, 6];
const replayFormatVersion = 6;

export interface ReplayHeader {
    replayVersion?: number;
    gameId: string;
    gameTimestamp: number;
    engineVersion: string;
    modHash: string;
    gameOptsSerialized: string;
}

export class Replay {
    public static readonly extension = '.rpl';
    public static readonly maxNameLength = 128;
    public static readonly engineLineRegex = /^ENGINE \d+\.\d+( \d+)?$/;

    public name: string = '';
    public timestamp: number = 0;
    public gameId: string = '';
    public gameTimestamp: number = 0;
    public gameOpts: any;
    public engineVersion: string = '';
    public modHash: string = '';
    public endTick?: number;
    public debugInfo?: string;
    public events: any[] = [];

    get finishedTick(): number {
        return this.endTick ?? 0;
    }

    public static sanitizeFileName(filename: string, replacement = '_'): string {
        return filename
            .replace(/[/?<>\\:*|"]/g, replacement)
            .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, replacement)
            .slice(0, this.maxNameLength);
    }

    init(gameId: string, gameTimestamp: number, gameOpts: any, engineVersion: string, modHash: string): void {        this.gameId = gameId;
        this.gameTimestamp = gameTimestamp;
        this.gameOpts = gameOpts;
        this.engineVersion = engineVersion;
        this.modHash = modHash;
        this.name = Replay.sanitizeFileName(
            this.gameOpts.mapTitle + ' ' + new Date().toISOString().replace(/(\.|,)\d+Z$/, 'Z'));
        this.timestamp = Date.now();
    }

    writeEvent(...events: any[]): void {
        this.events.push(...events);
    }

    finish(endTick: number): void {
        this.endTick = endTick;
    }

    getEvents(): any[] {
        return this.events;
    }

    *flush(): Generator<string> {
        if (!this.gameOpts) throw new Error('Game options must be set first');
        if (!this.engineVersion) throw new Error('Engine version is not set');
        if (this.modHash === undefined) throw new Error('Mod hash is not set');
        const serializer = new Serializer();
        let chunk = this.getHeaderTag() + '\n';
        chunk += `ENGINE ${this.engineVersion} ${this.modHash}\n`;
        chunk += [this.gameId, this.gameTimestamp, serializer.serializeOptions(this.gameOpts)].join(' ') + '\n';
        yield chunk;
        chunk = '';
        while (this.endTick === undefined || this.events.length) {
            for (const event of this.events) {
                chunk += event.tickNo + '=' + event.type + '|' + event.serialize() + '\n';
            }
            this.events.length = 0;
            yield chunk;
            chunk = '';
        }
        chunk += this.getEndTag() + ' ' + this.endTick + '\n';
        if (this.debugInfo) {
            chunk += Base64.encode(utf16ToBinaryString(this.debugInfo)) + '\n';
        }
        yield chunk;
    }

    serialize(): string {
        if (this.endTick === undefined) {
            throw new Error('Replay is not finished');
        }
        let result = '';
        const events = this.events.slice();
        for (const chunk of this.flush()) {
            result += chunk;
        }
        this.events = events;
        return result;
    }

    async parseHeader(data: string | Blob): Promise<ReplayHeader> {
        let lineIndex = 0;
        let replayVersion = 0;
        let engineVersion = '';
        let modHash = '';
        let gameId = '';
        let gameTimestamp = 0;
        let gameOptsSerialized = '';
        for await (const line of typeof data === 'string' ? data.split('\n') : makeTextFileLineIterator(data as File)) {
            if (lineIndex === 0) {
                replayVersion = this.readReplayVersion(line);
            }
            else if (lineIndex === 1) {
                if (!line.match(Replay.engineLineRegex)) {
                    throw new Error('Missing or invalid game engine version line');
                }
                const parts = line.split(' ');
                engineVersion = parts[1];
                modHash = replayVersion < 4 ? '0' : parts[2];
            }
            else {
                if (lineIndex !== 2) break;
                if (!line.match(/^([a-zA-Z0-9-]+) \d+ .*$/)) {
                    throw new Error('Missing or invalid game id/time/opts line');
                }
                const [id, timestamp, opts] = line.split(' ');
                gameId = id;
                gameTimestamp = Number(timestamp);
                gameOptsSerialized = replayVersion < 6 ? Base64.decode(opts) : opts;
            }
            lineIndex++;
        }
        if (lineIndex < 3) {
            throw new Error('Bad replay header');
        }
        return {
            replayVersion,
            engineVersion,
            modHash,
            gameId,
            gameTimestamp,
            gameOptsSerialized,
        };
    }

    unserialize(data: string, meta?: { name?: string; timestamp?: number }): void {
        const lines = data.split('\n');
        const version = this.readReplayVersion(lines.shift() || '');
        if (!supportedReplayVersions.includes(version)) {
            throw new Error('Unsupported replay version ' + version);
        }
        const parser = new Parser();
        const engineLine = lines.shift();
        if (!engineLine || !engineLine.match(Replay.engineLineRegex)) {
            throw new Error('Missing or invalid game engine version line');
        }
        const [, engineVersion, modHash] = engineLine.split(' ');
        const gameLine = lines.shift();
        if (!gameLine) {
            throw new Error('Missing game id/time/opts line');
        }
        const match = gameLine.match(/^([a-zA-Z0-9-]+) (\d+) (.*)$/);
        if (!match) {
            throw new Error('Invalid game id/time/opts line');
        }
        const [, gameId, timestamp, optsSerialized] = match;
        const opts = version < 6 ? Base64.decode(optsSerialized) : optsSerialized;
        const gameOpts = parser.parseOptions(opts);
        this.init(gameId, Number(timestamp), gameOpts, engineVersion, modHash);
        this.name = meta?.name ?? this.name;
        this.timestamp = meta?.timestamp ?? this.timestamp;
        let foundEnd = false;
        let endLine = '';
        let line: string | undefined;
        while (line = lines.shift()) {
            if (line.startsWith(this.getEndTag())) {
                foundEnd = true;
                endLine = line;
                break;
            }
            const eventMatch = line.match(/^(\d+)=(\d+)\|(.+)$/);
            if (!eventMatch) {
                throw new Error(`Invalid event line "${line}"`);
            }
            const [, tickNo, type, payload] = eventMatch;
            const event = new ReplayEventFactory(parser, new Serializer()).create(Number(type), Number(tickNo));
            event.unserialize(payload);
            this.writeEvent(event);
        }
        if (!foundEnd) {
            throw new Error('Incomplete replay data');
        }
        const endMatch = endLine.match(new RegExp(`^${this.getEndTag()} (\\d+)$`));
        if (!endMatch) {
            throw new Error('Invalid end tag');
        }
        this.endTick = Number(endMatch[1]);
        if (lines.length >= 1) {
            this.debugInfo = binaryStringToUtf16(Base64.decode(lines[0]));
        }
    }

    getHeaderTag(): string {
        return 'RA2TSREPL_v' + replayFormatVersion;
    }

    readReplayVersion(header: string): number {
        const match = header.match(/^RA2TSREPL_v(\d+)$/);
        if (!match || match.length < 2) {
            throw new Error('Unknown replay format');
        }
        return Number(match[1]);
    }

    getEndTag(): string {
        return 'END';
    }
}
