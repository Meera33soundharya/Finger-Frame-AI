// ============================================================
//  handTracker.ts
//  Real-time MediaPipe HandLandmarker – initialised once,
//  called every animation frame.
//
//  Uses locally-bundled WASM (/public/wasm) and the locally-
//  cached model (/public/models/hand_landmarker.task) so there
//  are no CDN round-trips after the first page load.
//
//  GPU delegate is tried first; if WebGL context creation fails
//  the tracker is transparently recreated with CPU delegate.
// ============================================================

import {
    FilesetResolver,
    HandLandmarker,
} from "@mediapipe/tasks-vision";

const WASM_PATH  = "/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";

let handLandmarker: HandLandmarker | null = null;
let initPromise:    Promise<HandLandmarker> | null = null;

/** Try delegate, throw on failure so caller can retry with CPU. */
async function buildTracker(
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

/**
 * Create (once) and return the MediaPipe HandLandmarker.
 * Safe to call multiple times – returns the cached instance.
 * Automatically falls back from GPU to CPU if WebGL init fails.
 */
export async function createHandTracker(): Promise<HandLandmarker> {
    if (handLandmarker) return handLandmarker;
    if (initPromise)    return initPromise;

    initPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

        let tracker: HandLandmarker;
        try {
            tracker = await buildTracker(vision, "GPU");
            console.log("[HandTracker] GPU ready");
        } catch (gpuErr) {
            console.warn("[HandTracker] GPU unavailable, using CPU fallback:", gpuErr);
            tracker = await buildTracker(vision, "CPU");
            console.log("[HandTracker] CPU fallback ready");
        }

        handLandmarker = tracker;
        return tracker;
    })();

    return initPromise;
}

/** Returns the cached instance (null before initialisation). */
export function getHandTracker(): HandLandmarker | null {
    return handLandmarker;
}

/**
 * Tear down the existing instance so a subsequent createHandTracker()
 * call will rebuild from scratch (used by retry flows).
 */
export async function resetHandTracker(): Promise<void> {
    try { handLandmarker?.close(); } catch { /* ignore */ }
    handLandmarker = null;
    initPromise    = null;
}