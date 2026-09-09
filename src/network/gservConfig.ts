export const API_VERSION = 3;
export const RECIPIENT_ALL = "#all";
export const RECIPIENT_TEAM = "#team";
export const GSERV_LOGIN_TIMEOUT_SECONDS = 30;
export const TURN_TIMEOUT_MILLIS = 30_000;
export const LAG_STATE_THRESH_MILLIS = 1_000;
export const CON_INFO_THRESH_MILLIS = 2_000;
export const LAG_CHECK_INTERVAL_MILLIS = 1_000;
export const LAN_LOAD_TIMEOUT_MILLIS = 60_000;
// Fallback only: the server always sends its actual configured countdown
// duration alongside RPL_GAME_PAUSE_COUNTDOWN/RPL_GAME_RESUME_COUNTDOWN, this
// is just a guard against a malformed/missing value.
export const DEFAULT_GAME_COUNTDOWN_MILLIS = 3_000;
