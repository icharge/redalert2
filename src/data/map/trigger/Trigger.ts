import type { Tag } from '../tag/Tag';
import type { TriggerEvent } from './TriggerEvent';
import type { TriggerAction } from './TriggerAction';

export class Trigger {
    id: string;
    houseName: string;
    attachedTriggerId?: string;
    attachedTrigger?: Trigger;
    name: string;
    disabled: boolean;
    difficulties: {
        easy: boolean;
        medium: boolean;
        hard: boolean;
    };
    events: TriggerEvent[];
    actions: TriggerAction[];
    tag: Tag;
}
