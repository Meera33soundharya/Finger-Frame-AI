// ============================================================
//  useFingerFrame.ts
//  Custom React hook that owns the entire camera + tracking +
//  rendering pipeline.
//
//  Architecture:
//   - All mutable tracking state lives in useRef (not useState)
//     so the component never re-renders during the hot RAF loop.
//   - The RAF loop draws directly to the <canvas> ref at ~60 fps.
//   - A decoupled async loop triggers AI inference requests when ready.
// ============================================================

import { useRef, useState, useEffect, useCallback } from "react";
import { createHandTracker } from "./handTracker";
import { computeQuad, dist, lerpPt } from "./fingerFrame";
import type { Point } from "./fingerFrame";
import { drawFrameOutline, STYLES, createFrameState } from "./effects";
import type { StyleId, FrameState } from "./effects";
import { applyLocalFilter } from "./filters";

// ── Smoothing constants (ported from reference) ──────────────
const MAX_LOST_FRAMES = 25;
const JUMP_CONFIRM_FRAMES = 2;

// ── Step 1: Load the local filter image ──────────────
const filterImage = new Image();
filterImage.src = "/filter.png";
filterImage.onload = () => {
    console.log("FILTER IMAGE LOADED");
    console.log("FILTER IMAGE WIDTH:", filterImage.width);
    console.log("FILTER IMAGE HEIGHT:", filterImage.height);
};
filterImage.onerror = (e) => {
    console.error("FAILED TO LOAD FILTER IMAGE. Check asset path.", e);
};

export type InitStatus =
    | "idle"
    | "loading-tracker"
    | "requesting-camera"
    | "ready"
    | "error";

export interface UseFingerFrameReturn {
    videoRef: React.RefObject<HTMLVideoElement>;
    canvasRef: React.RefObject<HTMLCanvasElement>;
    status: InitStatus;
    errorMessage: string;
    activeStyle: StyleId;
    setActiveStyle: (id: StyleId) => void;
    showHint: boolean;
}

export function useFingerFrame(): UseFingerFrameReturn {
    const videoRef = useRef<HTMLVideoElement>(null!);
    const canvasRef = useRef<HTMLCanvasElement>(null!);

    const [status, setStatus] = useState<InitStatus>("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [activeStyle, setActiveStyleState] = useState<StyleId>("movie3d");
    const [showHint, setShowHint] = useState(true);

    const styleRef = useRef<StyleId>("movie3d");
    const cornersRef = useRef<Point[] | null>(null);
    const presenceRef = useRef(0);
    const frameActiveRef = useRef(false);
    const lostFramesRef = useRef(0);
    const jumpFramesRef = useRef(0);
    const lastVideoTimeRef = useRef(-1);
    const rafIdRef = useRef(0);
    const trackerRef = useRef<Awaited<ReturnType<typeof createHandTracker>> | null>(null);
    const showHintRef = useRef(true);
    const lastFrameTimeRef = useRef(performance.now());
    const frameStateRef = useRef<FrameState>(createFrameState());

    const setActiveStyle = useCallback((id: StyleId) => {
        styleRef.current = id;
        setActiveStyleState(id);
    }, []);

    function drawMirroredVideo(
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        video: HTMLVideoElement
    ) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
    }

    // ── Main RAF render loop ──
    function loop() {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const tracker = trackerRef.current;

        if (!video || !canvas || !tracker) {
            rafIdRef.current = requestAnimationFrame(loop);
            return;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            rafIdRef.current = requestAnimationFrame(loop);
            return;
        }

        const w = canvas.width;
        const h = canvas.height;
        const t = performance.now() / 1000;

        // 1. Base layer: raw mirrored camera
        drawMirroredVideo(ctx, w, h, video);

        // 2. Run hand detection
        let targetQuad: Point[] | null = null;
        if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;
            try {
                const results = tracker.detectForVideo(video, performance.now());
                if (results?.landmarks?.length === 2) {
                    targetQuad = computeQuad(results.landmarks, w, h, frameActiveRef.current);
                }
            } catch {
                // Ignore detection throws before video is stable
            }
        }

        // 3. Smooth / hold / fade quad
        if (targetQuad) {
            if (!cornersRef.current) {
                cornersRef.current = targetQuad;
                lostFramesRef.current = 0;
                jumpFramesRef.current = 0;
                frameActiveRef.current = true;
                presenceRef.current = Math.min(1, presenceRef.current + 0.12);
            } else {
                const moved = targetQuad.reduce((s, p, i) => s + dist(p, cornersRef.current![i]), 0) / 4;
                const isJump = moved > w * 0.3;

                if (isJump && ++jumpFramesRef.current < JUMP_CONFIRM_FRAMES) {
                    if (++lostFramesRef.current > MAX_LOST_FRAMES) {
                        presenceRef.current = Math.max(0, presenceRef.current - 0.05);
                    }
                } else {
                    lostFramesRef.current = 0;
                    jumpFramesRef.current = 0;
                    frameActiveRef.current = true;

                    const alpha = Math.min(0.85, Math.max(0.35, moved / (w * 0.05)));
                    cornersRef.current = cornersRef.current.map((c, i) => lerpPt(c, targetQuad![i], alpha));
                    presenceRef.current = Math.min(1, presenceRef.current + 0.12);
                }
            }
        } else if (cornersRef.current && ++lostFramesRef.current <= MAX_LOST_FRAMES) {
            presenceRef.current = Math.min(1, presenceRef.current + 0.12);
        } else {
            presenceRef.current = Math.max(0, presenceRef.current - 0.05);
            if (presenceRef.current === 0) {
                cornersRef.current = null;
                frameActiveRef.current = false;
                jumpFramesRef.current = 0;
            }
        }

        // 4. Trigger AI & Composite Result
        if (cornersRef.current && presenceRef.current > 0.01) {
            const quad = cornersRef.current;
            const presence = presenceRef.current;

            // ── Draw local visual filter inside polygon ──
            ctx.save();
            ctx.globalAlpha = presence;

            // 1. Create polygon clipping path
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i++) {
                ctx.lineTo(quad[i].x, quad[i].y);
            }
            ctx.closePath();
            ctx.clip(); // MUST BE BEFORE drawImage

            // 2. Apply specific local filter (3D Animation, Watercolor, Sketch)
            applyLocalFilter(
                ctx, 
                video, 
                w, 
                h, 
                quad, 
                styleRef.current, 
                t, 
                filterImage
            );

            ctx.restore();

            // Frame outline (drawn on top)
            const styleDef = STYLES.find((s) => s.id === styleRef.current)!;
            const now = performance.now();
            const dt = Math.min(0.1, (now - lastFrameTimeRef.current) / 1000);
            lastFrameTimeRef.current = now;
            drawFrameOutline(ctx, quad, presence, t, styleDef.accentColor, styleDef, frameStateRef.current, dt);
        }

        // 5. Hint visibility
        const wantHint = presenceRef.current < 0.5;
        if (wantHint !== showHintRef.current) {
            showHintRef.current = wantHint;
            setShowHint(wantHint);
        }

        rafIdRef.current = requestAnimationFrame(loop);
    }

    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                setStatus("loading-tracker");
                const tracker = await createHandTracker();
                if (cancelled) return;
                trackerRef.current = tracker;

                setStatus("requesting-camera");
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 },
                        facingMode: "user",
                    },
                    audio: false,
                });
                if (cancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }

                const video = videoRef.current;
                video.srcObject = stream;
                await new Promise<void>((res) => {
                    video.onloadedmetadata = () => res();
                });
                await video.play();

                const canvas = canvasRef.current;
                canvas.width = video.videoWidth || 1280;
                canvas.height = video.videoHeight || 720;

                setStatus("ready");
                rafIdRef.current = requestAnimationFrame(loop);
            } catch (err) {
                if (cancelled) return;
                const msg = err instanceof Error ? 
                    (err.name === "NotAllowedError" ? "Camera access denied." : err.message) 
                    : "Initialisation failed.";
                setErrorMessage(msg);
                setStatus("error");
            }
        }

        init();

        return () => {
            cancelled = true;
            cancelAnimationFrame(rafIdRef.current);
            const video = videoRef.current;
            if (video?.srcObject) {
                (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        videoRef,
        canvasRef,
        status,
        errorMessage,
        activeStyle,
        setActiveStyle,
        showHint,
    };
}
