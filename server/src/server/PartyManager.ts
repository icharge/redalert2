import { ServerUser } from "./ServerUser";
import { WolServer } from "./WolServer";
import {
    RPL_PARTY_INVITE,
    RPL_PARTY_UPDATE,
    RPL_PARTY_INVITE_DECLINED,
    RPL_PARTY_INVITE_EXPIRED,
    RPL_PARTY_INVITE_SENT,
    RPL_PARTY_FORMED,
    RPL_PARTY_LEFT,
    RPL_PARTY_INVITE_PREVENTION,
    RPL_PARTY_INVITE_ERROR,
    ERR_TARGET_IN_PARTY,
    ERR_TARGET_IN_QUEUE,
    ERR_INVITER_IN_PARTY,
    ERR_ACCEPTER_IN_PARTY,
    ERR_INVITE_PREVENTED,
    ERR_TARGET_NO_INVITES,
    ERR_INVITE_ALREADY_PENDING,
    ERR_NO_INVITE,
    ERR_TARGET_NOT_IN_QUICK_MATCH,
    ERR_TARGET_SELF,
    ERR_INVITER_FRESH_ACCOUNT,
} from "../protocol/partyCodes";
import { randomId } from "../util/random";

interface PendingInvite {
    from: string;
    to: string;
    expiresAt: number;
}

export interface Party {
    id: string;
    members: [string, string];
    leader: string;
    ready: [boolean, boolean];
    status: "idle" | "queued";
}

export class PartyManager {
    private parties = new Map<string, Party>();
    private byNick = new Map<string, Party>();
    private pendingInvites = new Map<string, PendingInvite>();
    private inviteExpiryMs = 30_000;

    constructor(private server: WolServer) {
    }

    getParty(user: ServerUser): Party | undefined {
        return this.byNick.get(user.nick);
    }

    invite(user: ServerUser, targetName: string | undefined): void {
        if (!targetName || !user.authenticated) {
            return;
        }
        if (targetName === user.nick) {
            this.sendInviteError(user, ERR_TARGET_SELF, targetName);
            return;
        }
        if (this.byNick.has(user.nick)) {
            this.sendInviteError(user, ERR_INVITER_IN_PARTY);
            return;
        }
        const target = this.server.users.get(targetName);
        if (!target) {
            this.sendInviteError(user, ERR_TARGET_NOT_IN_QUICK_MATCH, targetName);
            return;
        }
        if (this.byNick.has(targetName)) {
            this.sendInviteError(user, ERR_TARGET_IN_PARTY, targetName);
            return;
        }
        if (target.inQueue) {
            this.sendInviteError(user, ERR_TARGET_IN_QUEUE, targetName);
            return;
        }
        if (target.noInvites) {
            this.sendInviteError(user, ERR_TARGET_NO_INVITES, targetName);
            return;
        }
        if (user.fresh) {
            this.sendInviteError(user, ERR_INVITER_FRESH_ACCOUNT, targetName);
            return;
        }
        if (target.preventInvites.has(user.nick)) {
            this.sendInviteError(user, ERR_INVITE_PREVENTED, targetName);
            return;
        }
        const existing = this.pendingInvites.get(targetName);
        if (existing) {
            if (existing.from === user.nick) {
                this.sendInviteError(user, ERR_INVITE_ALREADY_PENDING, targetName);
                return;
            }
            if (existing.expiresAt > Date.now()) {
                this.sendInviteError(user, ERR_INVITE_ALREADY_PENDING, targetName);
                return;
            }
            this.pendingInvites.delete(targetName);
        }
        this.pendingInvites.set(targetName, {
            from: user.nick,
            to: targetName,
            expiresAt: Date.now() + this.inviteExpiryMs,
        });
        this.sendParty(target, `${RPL_PARTY_INVITE} ${user.nick}`);
        this.sendParty(user, `${RPL_PARTY_INVITE_SENT} ${targetName}`);
    }

    accept(user: ServerUser, inviterName: string | undefined): void {
        const pending = this.pendingInvites.get(user.nick);
        if (!pending || pending.from !== inviterName || pending.expiresAt < Date.now()) {
            if (pending) {
                this.pendingInvites.delete(user.nick);
            }
            this.sendInviteError(user, ERR_NO_INVITE);
            return;
        }
        const inviter = this.server.users.get(inviterName ?? "");
        if (!inviter) {
            this.sendInviteError(user, ERR_NO_INVITE);
            return;
        }
        if (this.byNick.has(user.nick) || this.byNick.has(inviterName!)) {
            this.sendInviteError(user, ERR_ACCEPTER_IN_PARTY);
            return;
        }
        if (user.inQueue || inviter.inQueue) {
            this.sendInviteError(user, ERR_TARGET_IN_QUEUE, inviterName);
            return;
        }
        this.pendingInvites.delete(user.nick);
        const party: Party = {
            id: randomId("party"),
            members: [inviterName!, user.nick],
            leader: inviterName!,
            ready: [false, false],
            status: "idle",
        };
        this.parties.set(party.id, party);
        this.byNick.set(inviterName!, party);
        this.byNick.set(user.nick, party);
        inviter.partyId = party.id;
        user.partyId = party.id;
        this.sendParty(inviter, `${RPL_PARTY_FORMED} ${user.nick}`);
        this.sendParty(user, `${RPL_PARTY_FORMED} ${inviterName}`);
        this.sendPartyUpdate(party);
    }

    decline(user: ServerUser, inviterName: string | undefined): void {
        const pending = this.pendingInvites.get(user.nick);
        if (!pending || pending.from !== inviterName) {
            return;
        }
        this.pendingInvites.delete(user.nick);
        const inviter = this.server.users.get(inviterName ?? "");
        if (inviter) {
            this.sendParty(inviter, `${RPL_PARTY_INVITE_DECLINED} ${user.nick}`);
        }
    }

    inviteUnavailable(user: ServerUser, inviterName: string | undefined): void {
        const pending = this.pendingInvites.get(user.nick);
        if (pending) {
            this.pendingInvites.delete(user.nick);
        }
        const inviter = this.server.users.get(inviterName ?? "");
        if (inviter) {
            this.sendParty(inviter, `${RPL_PARTY_INVITE_ERROR} ${ERR_TARGET_IN_QUEUE} ${user.nick}`);
        }
    }

    leave(user: ServerUser): void {
        const party = this.byNick.get(user.nick);
        if (!party) {
            return;
        }
        this.sendToParty(party, `${RPL_PARTY_LEFT} ${user.nick}`);
        this.disband(party);
    }

    prevent(user: ServerUser, targetName: string | undefined, enabled: boolean): void {
        if (!targetName) {
            return;
        }
        if (enabled) {
            user.preventInvites.add(targetName);
        }
        else {
            user.preventInvites.delete(targetName);
        }
        this.sendParty(user, `${RPL_PARTY_INVITE_PREVENTION} ${targetName} 1`);
    }

    noInvites(user: ServerUser, enabled: boolean): void {
        user.noInvites = enabled;
    }

    status(user: ServerUser): void {
        const party = this.byNick.get(user.nick);
        if (party) {
            this.sendPartyUpdate(party);
        }
    }

    setReady(user: ServerUser, ready: boolean): void {
        const party = this.byNick.get(user.nick);
        if (!party) {
            return;
        }
        const index = party.members.indexOf(user.nick);
        if (index === -1) {
            return;
        }
        party.ready[index] = ready;
        this.sendPartyUpdate(party);
    }

    setQueued(user: ServerUser, queued: boolean): void {
        const party = this.byNick.get(user.nick);
        if (!party) {
            return;
        }
        party.status = queued ? "queued" : "idle";
        if (!queued) {
            party.ready = [false, false];
        }
        this.sendPartyUpdate(party);
    }

    private disband(party: Party): void {
        for (const nick of party.members) {
            const user = this.server.users.get(nick);
            if (user) {
                user.partyId = undefined;
            }
            this.byNick.delete(nick);
        }
        this.parties.delete(party.id);
    }

    private sendPartyUpdate(party: Party): void {
        const status = party.status === "queued" ? "queued" : "idle";
        const data = `${RPL_PARTY_UPDATE} ${party.id} ${party.members.join(",")} ${status} ${party.ready[0] ? 1 : 0} ${party.ready[1] ? 1 : 0}`;
        this.sendToParty(party, data);
    }

    private sendToParty(party: Party, data: string): void {
        for (const nick of party.members) {
            const user = this.server.users.get(nick);
            if (user) {
                this.sendParty(user, data);
            }
        }
    }

    private sendInviteError(user: ServerUser, code: string, targetName?: string): void {
        this.sendParty(user, `${RPL_PARTY_INVITE_ERROR} ${code}${targetName ? " " + targetName : ""}`);
    }

    private sendParty(user: ServerUser, data: string): void {
        user.send(`:${this.server.serverName} 731 ${user.nick} :${data}\r\n`);
    }
}
