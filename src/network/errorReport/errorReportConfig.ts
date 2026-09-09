// Shorter than WGameResService's 300s: a player who clicked "Skip" in the
// submitting-progress dialog (see GameScreen.handleError) has already moved
// on, so there is no UI left waiting on this — the retry loop below that
// point is just a courtesy best-effort, not worth holding onto for minutes.
export const ERROR_REPORT_RETRY_DURATION_MILLIS = 60_000;

// How long GameScreen's submitting-progress dialog waits before showing a
// Skip button. Same order of magnitude as GSERV_SNAPSHOT_REQUEST_TIMEOUT_MILLIS's
// existing 8000 default.
export const ERROR_REPORT_UI_TIMEOUT_MILLIS = 8_000;
