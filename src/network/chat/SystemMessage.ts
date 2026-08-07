import type { ChatMessage } from "@/network/chat/ChatMessage";
export interface SystemMessage {
    from: string;
    to: ChatMessage["to"];
    text: string;
    time: Date;
    system: true;
}
