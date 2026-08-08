// ============================================================
//  handTracker.ts
//  Real-time MediaPipe HandLandmarker – initialised once,
//  called every animation frame.
//
//  Uses locally-bundled WASM (/public/wasm) and the locally-
//  cached model (/public/models/hand_landmarker.task) so there
//  are no CDN round-trips after the first page load.
// ============================================================

import {
    FilesetResolver,
    HandLandmarker,
} from "@mediapipe/tasks-vision";

// Assets are served from /public/ by Vite unchanged
const WASM_PATH  = "/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";

let handLandmarker: HandLandmarker | null = null;

/**
 * Create (once) and return the MediaPipe HandLandmarker.
 * Safe to call multiple times – returns the cached instance.
 */
export async function createHandTracker(): Promise<HandLandmarker> {
    if (handLandmarker) return handLandmarker;

    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: MODEL_PATH,
            // GPU delegate gives ~3-5x throughput on supported hardware
            delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        // Permissive thresholds so partially-occluded / crossed hands
        // still get tracked (same values as the reference implementation).
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence:     0.3,
    });

    console.log("[HandTracker] MediaPipe HandLandmarker ready");
    return handLandmarker;
}

/** Returns the cached instance (null before initialisation). */
export function getHandTracker(): HandLandmarker | null {
    return handLandmarker;
}