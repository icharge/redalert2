import type { ChatMessage } from "@/network/chat/ChatMessage";
export interface Message {
    from: string;
    to: ChatMessage["to"];
    text: string;
    time: Date;
}
