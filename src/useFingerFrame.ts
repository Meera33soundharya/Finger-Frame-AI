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
import { createFaceTracker } from "./faceTracker";
import { computeQuad, dist, lerpPt, detectExtendedFingers, detectGesture } from "./fingerFrame";
import type { Point, FingerStates, GestureName } from "./fingerFrame";
import { drawFrameOutline, STYLES, createFrameState } from "./effects";
import type { StyleId, FrameState } from "./effects";
import { applyLocalFilter } from "./filters";
import { createBackend } from "./ai/modelBackend";
import type { AIModelBackend } from "./ai/types";
import type { FaceWarpResult } from "./faceWarper";
import { Compositor } from "./ai/compositor";

// ── Smoothing constants (ported from reference) ──────────────
const MAX_LOST_FRAMES = 25;
const JUMP_CONFIRM_FRAMES = 2;

// ── Step 1: Preload filter assets ──────────────
const filterImages: Partial<Record<StyleId, HTMLImageElement>> = {};

function loadAsset(id: StyleId, filename: string) {
    const img = new Image();
    img.src = `/${filename}`;
    img.onload = () => console.log(`[Asset] Loaded ${id}`);
    img.onerror = (e) => console.error(`[Asset] FAILED to load ${id} (/${filename})`, e);
    filterImages[id] = img;
}

loadAsset("movie3d", "filter_movie3d.png");
loadAsset("anime", "filter_anime.png");
loadAsset("cyberpunk", "filter_cyberpunk.png");
loadAsset("cyberpunk-girl", "filter_cyberpunk-girl.png");
loadAsset("watercolor", "filter_watercolor.png");
loadAsset("sketch", "filter_sketch.png");
loadAsset("oil-painting", "filter_oil-painting.png");
loadAsset("ghibli", "filter_ghibli.png");
// Reusing movie3d for pixar due to generation limits
loadAsset("pixar", "filter_movie3d.png");
// Reusing watercolor for portrait due to generation limits
loadAsset("portrait", "filter_watercolor.png");

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
    fingerStates: FingerStates | null;
    gesture: GestureName;
    retryCamera: () => void;
}

export function useFingerFrame(): UseFingerFrameReturn {
    const videoRef = useRef<HTMLVideoElement>(null!);
    const canvasRef = useRef<HTMLCanvasElement>(null!);

    const [status, setStatus] = useState<InitStatus>("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [activeStyle, setActiveStyleState] = useState<StyleId>("movie3d");
    const [showHint, setShowHint] = useState(true);
    const [fingerStates, setFingerStates] = useState<FingerStates | null>(null);
    const [gesture, setGesture] = useState<GestureName>(null);

    const styleRef = useRef<StyleId>("movie3d");
    const cornersRef = useRef<Point[] | null>(null);
    const presenceRef = useRef(0);
    const frameActiveRef = useRef(false);
    const lostFramesRef = useRef(0);
    const jumpFramesRef = useRef(0);
    const lastVideoTimeRef = useRef(-1);
    const rafIdRef = useRef(0);
    const trackerRef = useRef<Awaited<ReturnType<typeof createHandTracker>> | null>(null);
    const faceTrackerRef = useRef<Awaited<ReturnType<typeof createFaceTracker>> | null>(null);
    const showHintRef = useRef(true);
    const lastFrameTimeRef = useRef(performance.now());
    const frameStateRef = useRef<FrameState>(createFrameState());

    const aiBackendRef = useRef<AIModelBackend | null>(null);
    const latestAiResultRef = useRef<FaceWarpResult | null>(null);
    const isInferringRef = useRef(false);
    
    // To grab the current snapshot for AI
    const snapshotCanvasRef = useRef(document.createElement("canvas"));
    
    // Compositor for extracting cropped regions
    const compositorRef = useRef<Compositor | null>(null);
    function getCompositor(): Compositor {
        if (!compositorRef.current) {
            compositorRef.current = new Compositor();
        }
        return compositorRef.current;
    }

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
        const faceTracker = faceTrackerRef.current;

        if (!video || !canvas || !tracker || !faceTracker) {
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

        // 2. Run hand & face detection
        let targetQuad: Point[] | null = null;
        let faceResult: any = null;
        if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;
            try {
                const results = tracker.detectForVideo(video, performance.now());
                if (results?.landmarks?.length >= 1) {
                    targetQuad = computeQuad(results.landmarks, w, h, frameActiveRef.current);
                    
                    // Extract finger states from first hand
                    const firstHandLandmarks = results.landmarks[0];
                    if (firstHandLandmarks) {
                        const states = detectExtendedFingers(firstHandLandmarks);
                        setFingerStates(states);
                        
                        // Detect gesture
                        const detectedGesture = detectGesture(firstHandLandmarks);
                        setGesture(detectedGesture);
                    }
                }
                
                faceResult = faceTracker.detectForVideo(video, performance.now());
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

            // 1. Create polygon clipping path
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i++) {
                ctx.lineTo(quad[i].x, quad[i].y);
            }
            ctx.closePath();
            ctx.clip(); // clips all drawing to polygon shape

            // 2. Apply specific local filter — draws styled video directly on
            //    top of the raw video already in the canvas (source-over).
            //    globalAlpha is set inside applyLocalFilter via presence.
            applyLocalFilter(
                ctx,
                video,
                w,
                h,
                quad,
                styleRef.current,
                t,
                filterImages[styleRef.current] || null,
                presence,
                faceResult,
                latestAiResultRef.current || undefined
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

    const startCamera = async (isRetry = false) => {
        try {
            if (isRetry) {
                setStatus("requesting-camera");
                setErrorMessage("");
            }

            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error("Camera API is not supported");
            }

            if (videoRef.current?.srcObject) {
                (videoRef.current.srcObject as MediaStream)
                    .getTracks()
                    .forEach(track => track.stop());
                videoRef.current.srcObject = null;
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false
            });

            const video = videoRef.current;
            if (!video) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            video.autoplay = true;

            await new Promise<void>(resolve => {
                if (video.readyState >= 1) {
                    resolve();
                } else {
                    video.onloadedmetadata = () => resolve();
                }
            });

            await video.play();

            if (!video.videoWidth || !video.videoHeight) {
                throw new Error("Camera started but video dimensions are unavailable");
            }

            console.log("[Camera] Started:", video.videoWidth, "x", video.videoHeight);

            const canvas = canvasRef.current;
            canvas.width = video.videoWidth || 1280;
            canvas.height = video.videoHeight || 720;
            
            snapshotCanvasRef.current.width = canvas.width;
            snapshotCanvasRef.current.height = canvas.height;

            setStatus("ready");
            if (!rafIdRef.current) {
                rafIdRef.current = requestAnimationFrame(loop);
            }
            
            // Start Async AI Loop
            if (!isRetry) {
                runAiLoop();
            }

        } catch (error) {
            console.error("[Camera] Failed to start:", error);
            const msg = error instanceof Error ? 
                (error.name === "NotAllowedError" ? "Camera permission denied. Please allow camera access." :
                 error.name === "NotFoundError" ? "No camera found." :
                 error.name === "NotReadableError" ? "Camera is being used by another application." :
                 error.message) 
                : "Could not start video source";
            setErrorMessage(msg);
            setStatus("error");
        }
    };

    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                const backend = createBackend();
                await backend.initialize();
                aiBackendRef.current = backend;
                
                setStatus("loading-tracker");
                const tracker = await createHandTracker();
                const faceTracker = await createFaceTracker();
                if (cancelled) return;
                trackerRef.current = tracker;
                faceTrackerRef.current = faceTracker;

                await startCamera();
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

    const runAiLoop = async () => {
        if (!videoRef.current || !trackerRef.current || !faceTrackerRef.current || !aiBackendRef.current) return;
        if (isInferringRef.current) return;
        
        const video = videoRef.current;
        const faceTracker = faceTrackerRef.current;
        const backend = aiBackendRef.current;
        const style = styleRef.current;
        
        // Only run inference if there's a stable presence
        if (presenceRef.current > 0.5 && cornersRef.current) {
            try {
                isInferringRef.current = true;
                const snapCtx = snapshotCanvasRef.current.getContext("2d")!;
                snapCtx.save();
                snapCtx.translate(video.videoWidth, 0);
                snapCtx.scale(-1, 1);
                snapCtx.drawImage(video, 0, 0);
                snapCtx.restore();
                
                // Must get landmarks *at this exact moment*
                const result = faceTracker.detectForVideo(video, performance.now());
                if (result.faceLandmarks && result.faceLandmarks.length > 0) {
                    const promptMap: Record<string, string> = {
                        "movie3d": "High-quality 3D animated character portrait designed specifically for a real-time finger-frame camera filter, expressive large brown eyes, friendly surprised expression, natural dark hair, soft peach-pink skin tones, polished cinematic movie-animation quality, smooth realistic 3D facial shading, detailed eyes and hair, soft studio lighting, clean pastel background, centered face and upper body, front-facing composition, symmetrical composition, character looking directly at the camera, no text, no watermark, no border, no frame, no extra people, no duplicated face, high detail, sharp focus, consistent character proportions, 4K-quality render.",
                        "pixar": "High-quality 3D animated character portrait designed specifically for a real-time finger-frame camera filter, expressive large brown eyes, friendly surprised expression, natural dark hair, soft peach-pink skin tones, polished cinematic movie-animation quality, smooth realistic 3D facial shading, detailed eyes and hair, soft studio lighting, clean pastel background, centered face and upper body, front-facing composition, symmetrical composition, character looking directly at the camera, no text, no watermark, no border, no frame, no extra people, no duplicated face, high detail, sharp focus, consistent character proportions, 4K-quality render.",
                        "anime": "Transform the detected person into a refined hand-drawn anime illustration. Preserve the original person's pose, facial position, head orientation, body position, and composition. Use short black hair, calm expressive eyes, clean delicate ink lines, soft beige and warm skin tones, subtle watercolor shading, fine anime facial details, gentle line-art definition, vintage paper texture, minimalist artistic background, elegant hand-drawn appearance, refined Japanese anime illustration style, natural proportions, high-detail traditional sketch aesthetic",
                        "cyberpunk": "Cyberpunk character with intense sharp eyes, messy black hair, futuristic techwear, neon city atmosphere, electric-blue and purple lighting, cinematic rim lighting, highly detailed, intense, futuristic aesthetic",
                        "cyberpunk-girl": "Futuristic female cyberpunk character, expressive eyes, dark flowing hair, futuristic techwear, neon magenta and electric-blue lighting, cybernetic details, cyberpunk city atmosphere, highly detailed, intense, futuristic",
                        "sketch": "pencil sketch portrait, highly detailed, black and white, artistic line work",
                        "watercolor": "watercolor portrait painting, beautiful, artistic, soft flowing colors",
                        "oil-painting": "Transform the detected person into a traditional high-quality oil painting portrait. Preserve the original person's pose, facial structure, position, expression, and composition. Use soft natural facial features, warm skin tones, expressive eyes, rich layered colors, visible delicate oil brushstrokes, realistic paint texture, subtle highlights and shadows, soft classical lighting, textured canvas appearance, elegant classical portrait style, refined painterly details, natural proportions, museum-quality oil painting aesthetic",
                        "ghibli": "studio ghibli character, anime, detailed background, magical atmosphere",
                        "portrait": "professional studio portrait photography, cinematic lighting, high quality"
                    };
                    
                    // ✅ FIX: Crop the snapshot to polygon bounds BEFORE sending to AI
                    // This prevents the recursive camera-image bug where the full frame
                    // was being squeezed into the polygon, creating a miniature copy
                    const croppedToPolygon = getCompositor().extractRegion(
                        snapshotCanvasRef.current,
                        cornersRef.current
                    );
                    
                    const inferRes = await backend.infer({
                        croppedImage: croppedToPolygon,  // ✅ Only the cropped region
                        polygon: cornersRef.current,
                        prompt: promptMap[style] || promptMap["movie3d"],
                        timestamp: performance.now(),
                        presence: presenceRef.current
                    });
                    
                    // Only store the result if we actually got a canvas (real AI backend)
                    if (inferRes.outputCanvas) {
                        latestAiResultRef.current = {
                            image: inferRes.outputCanvas,
                            sourceLandmarks: result.faceLandmarks[0],
                            style: style
                        };
                    }
                }
            } catch (e) {
                if (e instanceof Error && e.message === "AUTH_FAILED") {
                    console.error("Authentication failed. Stopping AI generation loop.");
                    setErrorMessage("Fal.ai Authentication Failed. Check .env configuration.");
                    setStatus("error");
                    isInferringRef.current = false;
                    return; // Stop the loop entirely
                }
                console.warn("Async AI inference failed", e);
            } finally {
                isInferringRef.current = false;
            }
        }
        
        // Loop continuously with a small delay
        setTimeout(runAiLoop, 300); 
    };

    return {
        videoRef,
        canvasRef,
        status,
        errorMessage,
        activeStyle,
        setActiveStyle,
        showHint,
        fingerStates,
        gesture,
        retryCamera: () => startCamera(true),
    };
}
