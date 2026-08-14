import React from "react";
import { CompositeDisposable } from "../../../../util/disposable/CompositeDisposable";
const mimeTypeMap = new Map([
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
]);
interface MenuVideoProps {
    src: string | File | undefined;
}
interface MenuVideoState {
}
export class MenuVideo extends React.Component<MenuVideoProps, MenuVideoState> {
    private el: HTMLDivElement | null = null;
    private disposables: CompositeDisposable = new CompositeDisposable();
    private disposed: boolean = false;
    private timeoutId?: number;
    render() {
        const src = this.props.src;
        let url: string;
        let mimeType: string;
        if (typeof src === "string") {
            url = src;
            mimeType = mimeTypeMap.get(src.split("?")[0].split(".").pop() ?? "") ?? "video/webm";
        }
        else if (src) {
            url = URL.createObjectURL(src);
            mimeType = src.type;
            this.disposables.add(() => {
                URL.revokeObjectURL(url);
            });
        }
        else {
            url = "";
            mimeType = "video/webm";
        }
        return React.createElement("div", {
            className: "video-wrapper",
            ref: (ref) => (this.el = ref as HTMLDivElement),
            dangerouslySetInnerHTML: {
                __html: `
          <video style="outline: none;" loop playsinline muted autoplay>
              <source src="${url}" type="${mimeType}" />
          </video>
          <div class="logo" style="opacity: 0;" />
        `,
            },
        });
    }
    componentDidMount() {
        const src = this.props.src;
        const video = this.el?.querySelector("video");
        const logo = this.el?.querySelector("div");
        if (src instanceof File && window.MediaSource) {
            const errorHandler = async () => {
                this.applyMediaSourceFallback(video, await src.arrayBuffer());
            };
            video.querySelector("source").addEventListener("error", errorHandler, { once: true });
            video.addEventListener("loadeddata", () => {
                video.querySelector("source").removeEventListener("error", errorHandler);
            });
        }
        video.addEventListener("loadeddata", () => {
            logo.style.opacity = "";
        });
    }
    private async applyMediaSourceFallback(video: HTMLVideoElement, buffer: ArrayBuffer): Promise<void> {
        if (!this.disposed) {
            const mediaSource = new MediaSource();
            mediaSource.addEventListener("sourceopen", () => {
                try {
                    const sourceBuffer = mediaSource.addSourceBuffer('video/webm; codecs="vp8"');
                    sourceBuffer.mode = "sequence";
                    sourceBuffer.appendBuffer(buffer);
                    this.timeoutId = setTimeout(() => this.processNextSegment(sourceBuffer, video, buffer), 1000);
                    this.disposables.add(() => clearTimeout(this.timeoutId));
                }
                catch (error) {
                    if ((error as Error).name !== "NotSupportedError") {
                        console.error(error);
                    }
                }
            });
            const objectUrl = (video.src = URL.createObjectURL(mediaSource));
            this.disposables.add(() => {
                URL.revokeObjectURL(objectUrl);
            });
        }
    }
    private processNextSegment(sourceBuffer: SourceBuffer, video: HTMLVideoElement, buffer: ArrayBuffer): void {
        try {
            if (!sourceBuffer.updating && sourceBuffer.buffered.length > 0) {
                if (sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) - video.currentTime < 10) {
                    sourceBuffer.appendBuffer(buffer);
                }
                if (video.paused) {
                    video.play()?.catch((error) => console.error(error));
                }
            }
        }
        catch (error) {
            console.error(error);
            return;
        }
        this.timeoutId = setTimeout(() => this.processNextSegment(sourceBuffer, video, buffer), 1000);
    }
    componentWillUnmount() {
        this.disposables.dispose();
        this.disposed = true;
    }
}
