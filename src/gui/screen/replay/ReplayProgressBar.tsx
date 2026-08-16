import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface ReplayProgressBarProps {
    viewport: { x: number; y: number; width: number; height: number };
    getTick: () => number;
    getEndTick: () => number;
    getBaseSpeed: () => number;
    onSeek: (targetTick: number) => void;
    isSeekEnabled: () => boolean;
}

function formatGameTime(ticks: number, ticksPerSecond: number): string {
    const totalSeconds = Math.max(0, Math.floor(ticks / Math.max(1, ticksPerSecond)));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value: number) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export const ReplayProgressBar: React.FC<ReplayProgressBarProps> = ({ getTick, getEndTick, getBaseSpeed, onSeek, isSeekEnabled }) => {
    const [currentTick, setCurrentTick] = useState(getTick());
    const [previewTick, setPreviewTick] = useState<number | undefined>(undefined);
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);

    useEffect(() => {
        const intervalId = window.setInterval(() => setCurrentTick(getTick()), 250);
        return () => window.clearInterval(intervalId);
    }, [getTick]);

    const endTick = Math.max(0, getEndTick());
    const baseSpeed = getBaseSpeed();
    const enabled = isSeekEnabled();
    const displayedTick = previewTick ?? currentTick;
    const percent = endTick > 0 ? Math.min(100, Math.max(0, (displayedTick / endTick) * 100)) : 0;

    const tickAtClientX = useCallback((clientX: number): number => {
        const track = trackRef.current;
        if (!track || endTick <= 0) {
            return 0;
        }
        const rect = track.getBoundingClientRect();
        const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        return Math.round(Math.max(0, Math.min(1, ratio)) * endTick);
    }, [endTick]);

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!enabled) {
            return;
        }
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPreviewTick(tickAtClientX(event.clientX));
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!draggingRef.current) {
            return;
        }
        setPreviewTick(tickAtClientX(event.clientX));
    };
    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!draggingRef.current) {
            return;
        }
        draggingRef.current = false;
        const targetTick = tickAtClientX(event.clientX);
        setPreviewTick(undefined);
        if (targetTick !== getTick()) {
            onSeek(targetTick);
        }
    };
    const handlePointerCancel = (): void => {
        draggingRef.current = false;
        setPreviewTick(undefined);
    };

    return (
        <div className="replay-progress-bar">
            <div className="replay-progress-time">
                {formatGameTime(displayedTick, baseSpeed)} / {formatGameTime(endTick, baseSpeed)}
            </div>
            <div ref={trackRef}
                className={enabled ? "replay-progress-track" : "replay-progress-track disabled"}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}>
                <div className="replay-progress-fill" style={{ width: `${percent}%` }} />
                <div className="replay-progress-thumb" style={{ left: `${percent}%` }} />
            </div>
        </div>
    );
};
