export interface SdpCandidateSummary {
    totalCandidates: number;
    hasMdnsHostCandidate: boolean;
    hasPrivateIpv4Candidate: boolean;
    hasLoopbackCandidate: boolean;
    hasIpv6Candidate: boolean;
    hasSrflxCandidate: boolean;
    hasRelayCandidate: boolean;
}

function isPrivateIpv4(address: string): boolean {
    return /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function isIpv6(address: string): boolean {
    return address.includes(':');
}

function parseCandidateLine(line: string): { address?: string; type?: string } {
    const tokens = line.trim().split(/\s+/);
    const typIndex = tokens.indexOf('typ');
    return {
        address: tokens[4],
        type: typIndex >= 0 ? tokens[typIndex + 1] : undefined,
    };
}

export function summarizeSdpCandidates(description?: RTCSessionDescriptionInit | null): SdpCandidateSummary {
    const summary: SdpCandidateSummary = {
        totalCandidates: 0,
        hasMdnsHostCandidate: false,
        hasPrivateIpv4Candidate: false,
        hasLoopbackCandidate: false,
        hasIpv6Candidate: false,
        hasSrflxCandidate: false,
        hasRelayCandidate: false,
    };

    if (!description?.sdp) {
        return summary;
    }

    description.sdp
        .split(/\r?\n/)
        .filter((line) => line.startsWith('a=candidate:'))
        .forEach((line) => {
            summary.totalCandidates += 1;
            const { address = '', type } = parseCandidateLine(line);
            const normalizedAddress = address.toLowerCase();
            if (normalizedAddress.endsWith('.local')) {
                summary.hasMdnsHostCandidate = true;
            }
            if (isPrivateIpv4(normalizedAddress)) {
                summary.hasPrivateIpv4Candidate = true;
            }
            if (normalizedAddress === '127.0.0.1' || normalizedAddress === '::1' || normalizedAddress === 'localhost') {
                summary.hasLoopbackCandidate = true;
            }
            if (isIpv6(normalizedAddress)) {
                summary.hasIpv6Candidate = true;
            }
            if (type === 'srflx') {
                summary.hasSrflxCandidate = true;
            }
            if (type === 'relay') {
                summary.hasRelayCandidate = true;
            }
        });

    return summary;
}

export function formatSdpCandidateSummary(summary: SdpCandidateSummary): string {
    const parts = [
        `Candidates: ${summary.totalCandidates}`,
        summary.hasPrivateIpv4Candidate ? 'Has LAN IPv4' : 'No LAN IPv4',
        summary.hasMdnsHostCandidate ? 'Has mDNS hostname' : 'No mDNS hostname',
        summary.hasSrflxCandidate ? 'Has srflx' : 'No srflx',
        summary.hasRelayCandidate ? 'Has relay' : 'No relay',
    ];
    return parts.join(', ');
}

export function getSdpCandidateWarning(summary: SdpCandidateSummary): string | undefined {
    if (!summary.totalCandidates) {
        return 'The current SDP has not gathered any ICE candidates; cross-machine LAN direct connection will definitely fail.';
    }
    if (summary.hasMdnsHostCandidate &&
        !summary.hasPrivateIpv4Candidate &&
        !summary.hasSrflxCandidate &&
        !summary.hasRelayCandidate) {
        return 'The browser only exposed mDNS host candidates (*.local), with no LAN IPv4/srflx/relay candidates; same-machine or 127.0.0.1 often works, but cross-machine LAN is likely to fail because mDNS/UDP is blocked.';
    }
    return undefined;
}
