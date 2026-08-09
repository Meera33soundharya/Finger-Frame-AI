// ============================================================
//  faceTracker.ts
//  MediaPipe FaceLandmarker – 468 face landmarks at 30 fps.
//  Model downloaded from CDN on first use (~4 MB, then cached).
// ============================================================

import {
    FilesetResolver,
    FaceLandmarker,
} from "@mediapipe/tasks-vision";

const WASM_PATH = "/wasm";
// 4 MB model from Google's CDN – cached by browser after first load
const FACE_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let faceLandmarker: FaceLandmarker | null = null;
let initPromise: Promise<FaceLandmarker> | null = null;

export async function createFaceTracker(): Promise<FaceLandmarker> {
    if (faceLandmarker) return faceLandmarker;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        console.log("[FaceTracker] Loading FaceLandmarker model…");
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: FACE_MODEL_URL,
                delegate: "GPU",
            },
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: 0.4,
            minFacePresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
        });
        console.log("[FaceTracker] FaceLandmarker ready");
        return faceLandmarker;
    })();

    return initPromise;
}

export function getFaceTracker(): FaceLandmarker | null {
    return faceLandmarker;
}
