import { IniSection } from '@/data/IniSection';
import { CellTag } from './CellTag';
export class CellTagsReader {
    read(section: IniSection, version: number): CellTag[] {
        const result: CellTag[] = [];
        for (const [key, rawValue] of section.entries) {
            const tagId = typeof rawValue === 'string' ? Number(rawValue) : Number(rawValue);
            const coords = this.readCoords(Number(key), version);
            result.push({ tagId, coords });
        }
        return result;
    }
    readCoords(key: number, version: number): {
        x: number;
        y: number;
    } {
        const divisor = version < 4 ? 128 : 1000;
        return {
            x: key % divisor,
            y: Math.floor(key / divisor)
        };
    }
}
