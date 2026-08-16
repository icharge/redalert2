const buildId = typeof __GIT_HASH__ !== "undefined" ? __GIT_HASH__ : "dev";
export const version: string = `0.83.4-${buildId}`;
