import type { Client } from "@colyseus/core";
import type { MatchmakingRoom } from "./MatchmakingRoom.ts";

interface SignalingPayload {
    targetSessionId: string;
    description: RTCSessionDescriptionInit;
}

interface RTCSessionDescriptionInit {
    type: string;
    sdp?: string;
}

function relay(room: MatchmakingRoom, type: "webrtc-offer" | "webrtc-answer", client: Client, payload: SignalingPayload): void {
    const target = room.clients.getById(payload.targetSessionId);
    if (!target) {
        return;
    }
    const fromMember = room.state.members.get(client.sessionId);
    target.send(type, {
        fromSessionId: client.sessionId,
        fromPeerId: fromMember?.peerId ?? "",
        description: payload.description,
    });
}

export const signalingMessages = {
    "webrtc-offer"(this: MatchmakingRoom, client: Client, payload: SignalingPayload) {
        relay(this, "webrtc-offer", client, payload);
    },
    "webrtc-answer"(this: MatchmakingRoom, client: Client, payload: SignalingPayload) {
        relay(this, "webrtc-answer", client, payload);
    },
};
