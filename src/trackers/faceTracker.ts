// ============================================================
//  faceTracker.ts
//  MediaPipe FaceLandmarker – 468 face landmarks at 30 fps.
//  Model downloaded from CDN on first use (~4 MB, then cached).
//
//  GPU delegate is tried first; if WebGL context creation fails
//  the tracker is transparently recreated with CPU delegate.
// ============================================================

import {
    FilesetResolver,
    FaceLandmarker,
} from "@mediapipe/tasks-vision";

const WASM_PATH = "/wasm";
const FACE_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let faceLandmarker: FaceLandmarker | null = null;
let initPromise:    Promise<FaceLandmarker> | null = null;

/** Try delegate, throw on failure so caller can retry with CPU. */
async function buildTracker(
    vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    delegate: "GPU" | "CPU"
): Promise<FaceLandmarker> {
    return FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: FACE_MODEL_URL,
            delegate,
        },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence:  0.4,
        minTrackingConfidence:      0.4,
        outputFaceBlendshapes:               false,
        outputFacialTransformationMatrixes:  false,
    });
}

/**
 * Create (once) and return the MediaPipe FaceLandmarker.
 * Safe to call multiple times – returns the cached instance.
 * Automatically falls back from GPU to CPU if WebGL init fails.
 */
export async function createFaceTracker(): Promise<FaceLandmarker> {
    if (faceLandmarker) return faceLandmarker;
    if (initPromise)    return initPromise;

    initPromise = (async () => {
        console.log("[FaceTracker] Loading FaceLandmarker model…");
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

        let tracker: FaceLandmarker;
        try {
            tracker = await buildTracker(vision, "GPU");
            console.log("[FaceTracker] GPU ready");
        } catch (gpuErr) {
            console.warn("[FaceTracker] GPU unavailable, using CPU fallback:", gpuErr);
            tracker = await buildTracker(vision, "CPU");
            console.log("[FaceTracker] CPU fallback ready");
        }

        faceLandmarker = tracker;
        return tracker;
    })();

    return initPromise;
}

export function getFaceTracker(): FaceLandmarker | null {
    return faceLandmarker;
}

/**
 * Tear down the existing instance so a subsequent createFaceTracker()
 * call will rebuild from scratch (used by retry flows).
 */
export async function resetFaceTracker(): Promise<void> {
    try { faceLandmarker?.close(); } catch { /* ignore */ }
    faceLandmarker = null;
    initPromise    = null;
}
