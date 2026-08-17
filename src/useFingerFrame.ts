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
//   - GPU delegate is tried first; on failure the singleton is rebuilt
//     with CPU delegate so the webcam keeps running.
//   - detectGesture() is called each frame; debounced gestures trigger
//     style cycling (peace=next, rock=prev) or screenshot (pointing hold).
// ============================================================

import { useRef, useState, useEffect, useCallback } from "react";
import {
    FilesetResolver,
    HandLandmarker,
} from "@mediapipe/tasks-vision";
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { createFaceTracker, getFaceTracker } from "./trackers/faceTracker";
import { computeQuad, dist, lerpPt, detectGesture } from "./rendering/fingerFrameRenderer";
import type { Point } from "./rendering/fingerFrameRenderer";
import { drawFrameOutline, STYLES, createFrameState } from "./styles/effects";
import type { StyleId, FrameState } from "./styles/effects";
import { getFilteredCanvas } from "./styles/filters";
import { Compositor } from "./ai/compositor";
import { createBackend } from "./ai/modelBackend";
import type { AIModelBackend } from "./ai/types";

// ── MediaPipe asset paths (served from /public/) ─────────────────────
const WASM_PATH  = "/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";

// ── Module-level singleton (survives StrictMode double-mount) ─────────
let _trackerSingleton: HandLandmarker | null = null;
let _trackerPromise:   Promise<HandLandmarker> | null = null;

async function buildHandTracker(
    vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    delegate: "GPU" | "CPU"
): Promise<HandLandmarker> {
    return HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: MODEL_PATH,
            delegate,
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence:  0.3,
        minTrackingConfidence:      0.3,
    });
}

async function getHandTracker(): Promise<HandLandmarker> {
    if (_trackerSingleton) return _trackerSingleton;
    if (_trackerPromise)   return _trackerPromise;

    _trackerPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

        let tracker: HandLandmarker;
        try {
            tracker = await buildHandTracker(vision, "GPU");
            console.log("[HandTracker] GPU ready");
        } catch (gpuErr) {
            console.warn("[HandTracker] GPU unavailable, using CPU fallback:", gpuErr);
            tracker = await buildHandTracker(vision, "CPU");
            console.log("[HandTracker] CPU fallback ready");
        }

        _trackerSingleton = tracker;
        return tracker;
    })();

    return _trackerPromise;
}

// ── Smoothing / hold constants ────────────────────────────────────────────────
const MAX_LOST_FRAMES     = 25;
const JUMP_CONFIRM_FRAMES = 2;

// ── Gesture debounce ──────────────────────────────────────────────────────────
const GESTURE_COOLDOWN_MS  = 600;  // ms between style switches
const POINTING_HOLD_MS     = 1500; // ms hold to trigger screenshot

// ── Types ─────────────────────────────────────────────────────────────────────

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
    captureFrame:   () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFingerFrame(): UseFingerFrameReturn {

    const videoRef  = useRef<HTMLVideoElement>(null!);
    const canvasRef = useRef<HTMLCanvasElement>(null!);

    // ── React UI state ────────────────────────────────────────────────────────
    const [status,       setStatus]       = useState<Status>("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [activeStyle,  setActiveStyleState] = useState<StyleId>("oil-painting");
    const [showHint,     setShowHint]     = useState(true);

    // ── Mutable refs (hot path — never cause re-renders) ─────────────────────
    const styleRef         = useRef<StyleId>("oil-painting");
    const stylesRef        = useRef<StyleId[]>(STYLES.map(s => s.id));
    const trackerRef       = useRef<HandLandmarker | null>(null);
    const rafIdRef         = useRef(0);
    const streamRef        = useRef<MediaStream | null>(null);

    // Guard: prevent concurrent detectForVideo calls
    const detectingRef     = useRef(false);

    // Quad smoothing
    const cornersRef       = useRef<Point[] | null>(null);
    const presenceRef      = useRef(0);
    const frameActiveRef   = useRef(false);
    const lostFramesRef    = useRef(0);
    const jumpFramesRef    = useRef(0);
    const lastVideoTimeRef = useRef(-1);
    
    // Face tracking state
    const faceResultRef    = useRef<FaceLandmarkerResult | null>(null);

    // ── AI pipeline refs ──────────────────────────────────────────────────────
    // The latest AI-transformed canvas result, cached and reused every RAF frame
    const aiResultRef      = useRef<HTMLCanvasElement | null>(null);
    // The style that produced the cached AI result (to bust cache on style change)
    const aiResultStyleRef = useRef<StyleId | null>(null);
    // Whether an AI inference is currently in flight
    const isInferringRef   = useRef(false);
    // Whether the AI poll loop should keep running
    const aiRunningRef     = useRef(false);
    // AI backend singleton
    const backendRef       = useRef<AIModelBackend | null>(null);
    // Compositor: crops polygon region + warps result back
    const compositorRef    = useRef<Compositor | null>(null);

    // Frame outline animation state
    const lastFrameTimeRef = useRef(performance.now());
    const frameStateRef    = useRef<FrameState>(createFrameState());

    // Hint debounce
    const showHintRef = useRef(true);

    // Gesture debounce
    const lastGestureTimeRef    = useRef(0);
    const pointingStartTimeRef  = useRef(0);
    const lastGestureNameRef    = useRef<string | null>(null);

    // ── setActiveStyle ────────────────────────────────────────────────────────
    const setActiveStyle = useCallback((id: StyleId) => {
        styleRef.current = id;
        setActiveStyleState(id);
    }, []);

    // Keep stylesRef in sync when new custom styles added via toolbar
    // (App.tsx passes the full styles list through keyboard shortcut handler)
    const updateStylesList = useCallback((ids: StyleId[]) => {
        stylesRef.current = ids;
    }, []);
    // Expose so App.tsx can call it (unused for now — handled inline below)
    void updateStylesList;

    // ── Screenshot / frame capture ────────────────────────────────────────────
    const captureFrame = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        try {
            // Draw to a same-size offscreen canvas (avoids tainted canvas issues)
            const off = document.createElement("canvas");
            off.width  = canvas.width;
            off.height = canvas.height;
            const offCtx = off.getContext("2d")!;
            offCtx.drawImage(canvas, 0, 0);

            off.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a   = document.createElement("a");
                a.href     = url;
                a.download = `finger-frame-${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
            }, "image/png");
        } catch (e) {
            console.warn("[captureFrame] Failed:", e);
        }
    }, []);

    // ── Cycle style helpers ───────────────────────────────────────────────────
    const nextStyle = useCallback(() => {
        const ids = stylesRef.current;
        const idx = ids.indexOf(styleRef.current);
        const next = ids[(idx + 1) % ids.length];
        setActiveStyle(next);
    }, [setActiveStyle]);

    const prevStyle = useCallback(() => {
        const ids = stylesRef.current;
        const idx = ids.indexOf(styleRef.current);
        const prev = ids[(idx - 1 + ids.length) % ids.length];
        setActiveStyle(prev);
    }, [setActiveStyle]);

    // ── Helpers ───────────────────────────────────────────────────────────────

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

    // ── Main RAF render loop ──────────────────────────────────────────────────

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
        const vw = video.videoWidth  || 640;
        const vh = video.videoHeight || 480;
        if (canvas.width !== vw || canvas.height !== vh) {
            canvas.width  = vw;
            canvas.height = vh;
        }

        const w = canvas.width;
        const h = canvas.height;
        const t = performance.now() / 1000;

        // Reset canvas state every animation frame
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.filter = "none";

        // 1. Base layer: mirrored live webcam
        drawMirroredVideo(ctx, w, h, video);

        // 2. MediaPipe hand detection (only on new video frames,
        //    only when the video has actual pixel data, no concurrent calls)
        let targetQuad: Point[] | null = null;
        const hasData = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        if (
            hasData &&
            !detectingRef.current &&
            video.currentTime !== lastVideoTimeRef.current
        ) {
            lastVideoTimeRef.current = video.currentTime;
            detectingRef.current = true;
            try {
                const timestampMs = Math.round(performance.now());
                const results = tracker.detectForVideo(video, timestampMs);
                
                const faceTracker = getFaceTracker();
                if (faceTracker) {
                    faceResultRef.current = faceTracker.detectForVideo(video, timestampMs);
                }

                if (results?.landmarks?.length >= 1) {
                    targetQuad = computeQuad(results.landmarks, w, h, frameActiveRef.current);

                    // ── Gesture handling ─────────────────────────────────────
                    const now = performance.now();
                    const firstHand = results.landmarks[0];
                    const gesture = detectGesture(firstHand);

                    if (gesture !== lastGestureNameRef.current) {
                        lastGestureNameRef.current = gesture;
                        // Reset pointing timer on gesture change
                        pointingStartTimeRef.current = gesture === "pointing" ? now : 0;
                    }

                    const cooldownOk = now - lastGestureTimeRef.current > GESTURE_COOLDOWN_MS;

                    if (gesture === "peace" && cooldownOk) {
                        lastGestureTimeRef.current = now;
                        nextStyle();
                    } else if (gesture === "rock" && cooldownOk) {
                        lastGestureTimeRef.current = now;
                        prevStyle();
                    } else if (gesture === "pointing") {
                        // Held-pointing = screenshot after POINTING_HOLD_MS
                        if (
                            pointingStartTimeRef.current > 0 &&
                            now - pointingStartTimeRef.current > POINTING_HOLD_MS &&
                            cooldownOk
                        ) {
                            lastGestureTimeRef.current = now;
                            pointingStartTimeRef.current = 0;
                            captureFrame();
                        }
                    }
                }
            } catch {
                // Ignore transient detection errors (video not yet stable, etc.)
            } finally {
                detectingRef.current = false;
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

        // 4. Composite filter result inside the quad polygon
        if (cornersRef.current && presenceRef.current > 0.01) {
            const quad     = cornersRef.current;
            const presence = presenceRef.current;
            const style    = styleRef.current;

            // If the cached AI result belongs to a different style, discard it
            if (aiResultStyleRef.current !== style) {
                aiResultRef.current = null;
                aiResultStyleRef.current = null;
            }

            const aiCanvas = aiResultRef.current;

            ctx.save();
            ctx.globalAlpha = presence;
            ctx.globalCompositeOperation = "source-over";

            // Clip to the exact polygon shape
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
            ctx.closePath();
            ctx.clip();

            if (aiCanvas && aiCanvas.width > 0 && aiCanvas.height > 0) {
                // ✅ AI result available — warp it precisely into the polygon
                console.debug("[Composite] AI result rendered inside polygon");
                ctx.restore(); // restore before renderWarped (it does its own save/restore)
                compositorRef.current?.renderWarped(ctx, aiCanvas, quad, presence);
            } else {
                // ✅ Local CPU filter — always produces visible pixels immediately
                // This is the guaranteed fallback when AI is pending / no API key
                const filterCanvas = getFilteredCanvas(video, w, h, style, t, null, quad, faceResultRef.current);
                console.debug(`[Composite] Local filter rendered: ${filterCanvas.width}x${filterCanvas.height}`);
                ctx.drawImage(filterCanvas, 0, 0, w, h);
                ctx.restore();
            }

            // Frame outline drawn on top
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

    // ── Camera start ──────────────────────────────────────────────────────────

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

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: "user" },
                audio: false,
            });

            streamRef.current = stream;

            const video = videoRef.current;
            if (!video) throw new Error("Video element not mounted");

            video.srcObject   = stream;
            video.muted       = true;
            video.playsInline = true;

            await new Promise<void>(resolve => {
                if (video.readyState >= 1) return resolve();
                video.onloadedmetadata = () => resolve();
            });
            await video.play();

            // Sync canvas immediately
            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width  = video.videoWidth  || 640;
                canvas.height = video.videoHeight || 480;
            }

            console.log(`[Camera] Started: ${video.videoWidth} x ${video.videoHeight}`);
            setStatus("ready");

            // (Re)start render loop — cancel any stale loop first
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

    // ── Initialization (once, StrictMode-safe) ────────────────────────────────

    useEffect(() => {
        let cancelled = false;

        // ── AI poll loop ──────────────────────────────────────────────────────
        // Runs independently from RAF. Grabs the current polygon crop, sends it
        // to the AI backend, and stores the result. The RAF loop reads the result.
        async function pollAIFrames() {
            // AI polling disabled as per user request to use real-time local pixel filters
            // rather than generating completely new images.
            return;
        }

        async function init() {
            try {
                setStatus("loading-tracker");

                // Initialize AI backend + compositor
                const backend = createBackend();
                await backend.initialize();
                console.log("[AI Filter] Model initialized");
                backendRef.current = backend;
                compositorRef.current = new Compositor();

                // GPU→CPU fallback is handled inside getHandTracker()
                const tracker = await getHandTracker();
                if (cancelled) return;
                trackerRef.current = tracker;

                await createFaceTracker();
                if (cancelled) return;

                await startCamera();

                // Start the async AI frame polling loop
                aiRunningRef.current = true;
                pollAIFrames();
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

            // Stop AI poll loop
            aiRunningRef.current = false;

            // Stop render loop
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = 0;

            // Stop camera tracks only on unmount
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }
            if (videoRef.current) {
                videoRef.current.srcObject = null;
            }

            // Reset smoothing state so retry starts clean
            cornersRef.current     = null;
            presenceRef.current    = 0;
            frameActiveRef.current = false;
            lostFramesRef.current  = 0;
            jumpFramesRef.current  = 0;
            detectingRef.current   = false;

            // Dispose AI backend
            backendRef.current?.dispose();
            backendRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        videoRef,
        canvasRef,
        status,
        errorMessage,
        activeStyle,
        setActiveStyle,
        showHint,
        retryCamera: startCamera,
        captureFrame,
    };
}
