// ============================================================
//  useFingerFrame.ts
//  Custom React hook: webcam + MediaPipe hand tracking + canvas render.
//
//  Architecture:
//   - One requestAnimationFrame loop draws mirrored camera, runs
//     MediaPipe detection, smooths the quad, and renders the filter.
//   - All mutable tracking state lives in useRef so re-renders don't
//     interrupt the hot loop.
//   - A module-level tracker singleton prevents double-init under
//     React StrictMode.
// ============================================================

import { useRef, useState, useEffect, useCallback } from "react";
import {
    FilesetResolver,
    HandLandmarker,
} from "@mediapipe/tasks-vision";
import { computeQuad, dist, lerpPt } from "./fingerFrame";
import type { Point } from "./fingerFrame";
import { drawFrameOutline, STYLES, createFrameState } from "./effects";
import type { StyleId, FrameState } from "./effects";
import { applyLocalFilter } from "./filters";

// ── MediaPipe asset paths (served from /public/) ─────────────────────
const WASM_PATH  = "/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";

// ── Module-level singleton (survives StrictMode double-mount) ─────────
let _trackerSingleton: HandLandmarker | null = null;
let _trackerPromise: Promise<HandLandmarker> | null = null;

async function getHandTracker(): Promise<HandLandmarker> {
    if (_trackerSingleton) return _trackerSingleton;
    if (_trackerPromise) return _trackerPromise;

    _trackerPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
        const tracker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: MODEL_PATH,
                delegate: "GPU",
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.3,
            minHandPresenceConfidence:  0.3,
            minTrackingConfidence:      0.3,
        });
        _trackerSingleton = tracker;
        console.log("[HandTracker] MediaPipe HandLandmarker ready");
        return tracker;
    })();

    return _trackerPromise;
}

// All filters use live webcam — no static asset preloading needed.

// ── Smoothing / hold constants ────────────────────────────────────────
const MAX_LOST_FRAMES    = 25;
const JUMP_CONFIRM_FRAMES = 2;

// ── Types ─────────────────────────────────────────────────────────────

type Status =
    | "idle"
    | "loading-tracker"
    | "requesting-camera"
    | "ready"
    | "error";

export interface UseFingerFrameReturn {
    videoRef:       React.RefObject<HTMLVideoElement>;
    canvasRef:      React.RefObject<HTMLCanvasElement>;
    status:         Status;
    errorMessage:   string;
    activeStyle:    StyleId;
    setActiveStyle: (id: StyleId) => void;
    showHint:       boolean;
    retryCamera:    () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useFingerFrame(): UseFingerFrameReturn {

    const videoRef  = useRef<HTMLVideoElement>(null!);
    const canvasRef = useRef<HTMLCanvasElement>(null!);

    // ── React UI state ────────────────────────────────────────────────
    const [status,       setStatus]       = useState<Status>("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [activeStyle,  setActiveStyleState] = useState<StyleId>("movie3d");
    const [showHint,     setShowHint]     = useState(true);

    // ── Mutable refs (hot path — never cause re-renders) ─────────────
    const styleRef         = useRef<StyleId>("movie3d");
    const trackerRef       = useRef<HandLandmarker | null>(null);
    const rafIdRef         = useRef(0);
    const streamRef        = useRef<MediaStream | null>(null);

    // Quad smoothing
    const cornersRef       = useRef<Point[] | null>(null);
    const presenceRef      = useRef(0);
    const frameActiveRef   = useRef(false);
    const lostFramesRef    = useRef(0);
    const jumpFramesRef    = useRef(0);
    const lastVideoTimeRef = useRef(-1);

    // Frame outline animation state
    const lastFrameTimeRef = useRef(performance.now());
    const frameStateRef    = useRef<FrameState>(createFrameState());

    // Hint debounce
    const showHintRef = useRef(true);

    // ── setActiveStyle ────────────────────────────────────────────────
    const setActiveStyle = useCallback((id: StyleId) => {
        styleRef.current = id;
        setActiveStyleState(id);
    }, []);

    // ── Helpers ───────────────────────────────────────────────────────

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

    // ── Main RAF render loop ──────────────────────────────────────────

    function loop() {
        const video   = videoRef.current;
        const canvas  = canvasRef.current;
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

        // Sync canvas size to live video dimensions
        const vw = video.videoWidth  || 1280;
        const vh = video.videoHeight || 720;
        if (canvas.width !== vw || canvas.height !== vh) {
            canvas.width  = vw;
            canvas.height = vh;
        }

        const w = canvas.width;
        const h = canvas.height;
        const t = performance.now() / 1000;

        // 1. Base layer: mirrored live webcam
        drawMirroredVideo(ctx, w, h, video);

        // 2. MediaPipe hand detection (only on new video frames)
        let targetQuad: Point[] | null = null;
        if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;
            try {
                const results = tracker.detectForVideo(video, performance.now());
                if (results?.landmarks?.length >= 1) {
                    targetQuad = computeQuad(results.landmarks, w, h, frameActiveRef.current);
                }
            } catch {
                // Ignore detection errors before video is fully stable
            }
        }

        // 3. Smooth / hold / fade the quad
        if (targetQuad) {
            if (!cornersRef.current) {
                cornersRef.current = targetQuad;
                lostFramesRef.current  = 0;
                jumpFramesRef.current  = 0;
                frameActiveRef.current = true;
                presenceRef.current    = Math.min(1, presenceRef.current + 0.12);
            } else {
                const moved = targetQuad.reduce(
                    (s, p, i) => s + dist(p, cornersRef.current![i]), 0
                ) / 4;
                const isJump = moved > w * 0.3;

                if (isJump && ++jumpFramesRef.current < JUMP_CONFIRM_FRAMES) {
                    if (++lostFramesRef.current > MAX_LOST_FRAMES) {
                        presenceRef.current = Math.max(0, presenceRef.current - 0.05);
                    }
                } else {
                    lostFramesRef.current  = 0;
                    jumpFramesRef.current  = 0;
                    frameActiveRef.current = true;

                    const alpha = Math.min(0.85, Math.max(0.35, moved / (w * 0.05)));
                    cornersRef.current = cornersRef.current.map(
                        (c, i) => lerpPt(c, targetQuad![i], alpha)
                    );
                    presenceRef.current = Math.min(1, presenceRef.current + 0.12);
                }
            }
        } else if (cornersRef.current && ++lostFramesRef.current <= MAX_LOST_FRAMES) {
            presenceRef.current = Math.min(1, presenceRef.current + 0.12);
        } else {
            presenceRef.current = Math.max(0, presenceRef.current - 0.05);
            if (presenceRef.current === 0) {
                cornersRef.current  = null;
                frameActiveRef.current = false;
                jumpFramesRef.current  = 0;
            }
        }

        // 4. Draw filter inside the quad polygon
        if (cornersRef.current && presenceRef.current > 0.01) {
            const quad     = cornersRef.current;
            const presence = presenceRef.current;
            const style    = styleRef.current;

            ctx.save();
            ctx.globalAlpha = presence;

            // Clip to polygon
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
            ctx.closePath();
            ctx.clip();

            // Apply per-style visual filter (all live webcam)
            applyLocalFilter(ctx, video, w, h, quad, style, t, null);

            ctx.restore();

            // Frame outline drawn on top of clipped filter
            const styleDef = STYLES.find((s) => s.id === style)!;
            const now = performance.now();
            const dt  = Math.min(0.1, (now - lastFrameTimeRef.current) / 1000);
            lastFrameTimeRef.current = now;
            drawFrameOutline(ctx, quad, presence, t, styleDef.accentColor, styleDef, frameStateRef.current, dt);
        }

        // 5. Hint visibility toggle
        const wantHint = presenceRef.current < 0.5;
        if (wantHint !== showHintRef.current) {
            showHintRef.current = wantHint;
            setShowHint(wantHint);
        }

        rafIdRef.current = requestAnimationFrame(loop);
    }

    // ── Camera start ──────────────────────────────────────────────────

    const startCamera = useCallback(async () => {
        try {
            setStatus("requesting-camera");
            setErrorMessage("");

            // Tear down any existing stream
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }
            if (videoRef.current) videoRef.current.srcObject = null;

            // Try HD first, fall back to SD
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
                audio: false,
            }).catch(() =>
                navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
                    audio: false,
                })
            );

            streamRef.current = stream;

            const video = videoRef.current;
            if (!video) throw new Error("Video element not mounted");

            video.srcObject  = stream;
            video.muted      = true;
            video.playsInline = true;

            await new Promise<void>(resolve => {
                if (video.readyState >= 1) return resolve();
                video.onloadedmetadata = () => resolve();
            });
            await video.play();

            // Sync canvas immediately
            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width  = video.videoWidth  || 1280;
                canvas.height = video.videoHeight || 720;
            }

            console.log(`[Camera] ${video.videoWidth} × ${video.videoHeight}`);
            setStatus("ready");

            // (Re)start render loop
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = requestAnimationFrame(loop);

        } catch (err) {
            const msg = err instanceof Error
                ? (err.name === "NotAllowedError" ? "Camera permission denied."
                 : err.name === "NotFoundError"   ? "No camera found."
                 : err.message)
                : "Could not start webcam.";
            console.error("[Camera] Failed:", err);
            setErrorMessage(msg);
            setStatus("error");
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Initialization (once, StrictMode-safe) ────────────────────────

    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                setStatus("loading-tracker");

                const tracker = await getHandTracker();
                if (cancelled) return;
                trackerRef.current = tracker;

                await startCamera();
            } catch (err) {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : "Initialisation failed.";
                setErrorMessage(msg);
                setStatus("error");
            }
        }

        init();

        return () => {
            cancelled = true;
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = 0;

            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }
            if (videoRef.current) {
                videoRef.current.srcObject = null;
            }
            // Reset smoothing state so retry starts clean
            cornersRef.current  = null;
            presenceRef.current = 0;
            frameActiveRef.current = false;
            lostFramesRef.current  = 0;
            jumpFramesRef.current  = 0;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Public API ────────────────────────────────────────────────────

    return {
        videoRef,
        canvasRef,
        status,
        errorMessage,
        activeStyle,
        setActiveStyle,
        showHint,
        retryCamera: startCamera,
    };
}
