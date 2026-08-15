import { ServerUser } from "./ServerUser";

export interface ChannelMember {
    user: ServerUser;
    operator: boolean;
}

export class Channel {
    members = new Map<string, ChannelMember>();
    limit = 0;

    constructor(
        public key: string,
        public name: string,
        public password?: string,
        public channelType?: number,
    ) {
    }

    isFull(): boolean {
        return this.limit > 0 && this.members.size >= this.limit;
    }

    addMember(user: ServerUser, operator = false): void {
        this.members.set(user.nick, { user, operator });
        user.channels.add(this.key);
    }

    removeMember(user: ServerUser): void {
        this.members.delete(user.nick);
        user.channels.delete(this.key);
    }

    has(nick: string): boolean {
        return this.members.has(nick);
    }
}
