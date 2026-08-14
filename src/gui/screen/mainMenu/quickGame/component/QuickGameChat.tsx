import React from "react";
import { Chat } from "@/gui/component/Chat";
import { List } from "@/gui/component/List";
import ChannelUser from "@/gui/component/ChannelUser";
import { ChatRecipientType } from "@/network/chat/ChatMessage";
interface QuickGameChatProps {
    strings: any;
    messages: any[];
    channels: any[];
    localUsername: string;
    users: any[];
    chatHistory: any;
    playerProfiles: Map<string, any>;
    onSendMessage: (message: any) => void;
    inviteToTeamDisabled?: boolean;
    onInviteToTeam?: (user: any) => void;
}
export const QuickGameChat: React.FC<QuickGameChatProps> = ({ strings, messages, channels, localUsername, users, chatHistory, playerProfiles, onSendMessage, inviteToTeamDisabled, onInviteToTeam, }) => {
    const menuItems = users.map((user: any) => [{
        label: strings.get("GUI:PlayerMenuMessage"),
        onClick: () => {
            chatHistory.lastComposeTarget.value = {
                type: ChatRecipientType.Whisper,
                name: user.name,
            };
        },
    }, ...(onInviteToTeam ? [{
        label: strings.get("GUI:PlayerMenuInvite"),
        disabled: inviteToTeamDisabled,
        onClick: () => onInviteToTeam(user),
    }] : [])]);
    return React.createElement(React.Fragment, null, React.createElement(Chat, {
        strings: strings,
        messages: messages,
        channels: channels ?? [],
        chatHistory: chatHistory,
        localUsername: localUsername,
        onSendMessage: onSendMessage,
        onCancelMessage: () => {},
        tooltips: {
            input: strings.get("STT:LobbyEditInput"),
            output: strings.get("STT:LobbyEditOutput"),
            button: strings.get("STT:EmoteButton"),
        },
    }), React.createElement(List, {
        className: "players-list",
        tooltip: strings.get("STT:LobbyListUsers"),
    }, users.map((user, index) => {
        const playerProfile = playerProfiles.get(user.name);
        return React.createElement(ChannelUser, {
            key: user.name,
            user: user,
            playerProfile: playerProfile,
            strings: strings,
            localUsername: localUsername,
            menuItems: menuItems[index],
        });
    })));
};
