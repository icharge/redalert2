import type { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import type { MainMenuScreenType } from "@/gui/screen/ScreenType";

export interface MultiplayerLoginParams {
    afterLogin: (messages: { text: string }[]) => MainMenuRoute | {
        screenType: MainMenuScreenType;
        params: any;
    };
    forceRestoreSession?: boolean;
}
