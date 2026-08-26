import { TagRepeatType } from './TagRepeatType';
import { Tag } from './Tag';
import { IniSection } from '@/data/IniSection';
export class TagsReader {
    read(section: IniSection): Tag[] {
        const result: Tag[] = [];
        for (const [id, rawValue] of section.entries) {
            if (typeof rawValue !== 'string') {
                continue;
            }
            const parts = rawValue.split(',');
            if (parts.length < 3) {
                console.warn(`Invalid tag ${id}=${rawValue}. Skipping.`);
                continue;
            }
            const repeatType = Number(parts[0]);
            if (TagRepeatType[repeatType] === undefined) {
                console.warn(`Invalid repeat value ${repeatType} for tag id ${id}. Skipping.`);
                continue;
            }
            result.push({
                id,
                repeatType,
                name: parts[1],
                triggerId: parts[2]
            });
        }
        return result;
    }
}
