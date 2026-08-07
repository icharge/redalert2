export enum ChatRecipientType {
    Channel = 0,
    Page = 1,
    Whisper = 2,
}
export interface ChatMessage {
    from: string;
    to: {
        type: ChatRecipientType;
        name: string;
    };
    text: string;
    time: Date;
}
