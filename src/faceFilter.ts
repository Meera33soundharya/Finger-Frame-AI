import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { StyleId } from "./effects";
import { warpFace, type FaceWarpResult } from "./faceWarper";

// ------------------------------------------------------------
// FACE REGION INDICES
// ------------------------------------------------------------
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

// ------------------------------------------------------------
// OFFSCREEN CANVAS MANAGEMENT
// ------------------------------------------------------------
let faceOffscreen: HTMLCanvasElement | null = null;
let faceOffscreenCtx: CanvasRenderingContext2D | null = null;

function ensureFaceCanvas(w: number, h: number) {
    if (!faceOffscreen) {
        faceOffscreen = document.createElement("canvas");
        faceOffscreenCtx = faceOffscreen.getContext("2d", { willReadFrequently: false });
    }
    if (faceOffscreen.width !== w || faceOffscreen.height !== h) {
        faceOffscreen.width = w;
        faceOffscreen.height = h;
    }
    return { canvas: faceOffscreen, ctx: faceOffscreenCtx! };
}

function drawRegionPath(ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], indices: number[], w: number, h: number) {
    ctx.beginPath();
    for (let i = 0; i < indices.length; i++) {
        const lm = landmarks[indices[i]];
        // X is mirrored because the video is mirrored during rendering
        const x = (1 - lm.x) * w;
        const y = lm.y * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

// ------------------------------------------------------------
// MAIN FACE FILTER FUNCTION
// ------------------------------------------------------------
export function applyFaceFilter(
    mainCtx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    w: number,
    h: number,
    faceResult: FaceLandmarkerResult,
    style: StyleId,
    presence: number,
    aiResult?: FaceWarpResult | null
) {
    if (!faceResult.faceLandmarks || faceResult.faceLandmarks.length === 0) return false;

    const landmarks = faceResult.faceLandmarks[0];
    
    // If we have an AI generated face and it matches the current style, warp it!
    if (aiResult && aiResult.style === style) {
        // Draw the warped face directly onto the main context
        warpFace(mainCtx, w, h, aiResult, landmarks, presence);
        return true;
    }

    const { canvas: off, ctx: offCtx } = ensureFaceCanvas(w, h);

    // 1. CLEAR OFFSCREEN
    offCtx.clearRect(0, 0, w, h);

    // 2. SETUP OFFSCREEN STYLING BASED ON STYLE
    offCtx.save();
    
    let filterString = "none";
    let skinWash = "transparent";
    let skinWashOp = "source-over" as GlobalCompositeOperation;
    let skinWashAlpha = 0;
    
    switch (style) {
        case "movie3d":
        case "pixar":
            filterString = "saturate(1.55) contrast(1.18) brightness(1.08) sepia(0.06)";
            break;
        case "anime":
            filterString = "saturate(1.8) contrast(1.25) brightness(1.08)";
            skinWash = "rgba(255,170,205,1)";
            skinWashOp = "soft-light";
            skinWashAlpha = 0.12 * presence;
            break;
        case "sketch":
            filterString = "grayscale(1) contrast(2.15) brightness(1.18)";
            skinWash = "rgba(235,225,205,1)";
            skinWashOp = "multiply";
            skinWashAlpha = 0.22 * presence;
            break;
        case "cyberpunk":
        case "cyberpunk-girl":
            filterString = "saturate(2.2) contrast(1.4) brightness(0.9) hue-rotate(150deg)";
            break;
        default:
            filterString = "saturate(1.2) contrast(1.1)";
            break;
    }

    // 3. DRAW FILTERED VIDEO ONLY IN FACE OVAL
    offCtx.beginPath();
    drawRegionPath(offCtx, landmarks, FACE_OVAL, w, h);
    offCtx.clip(); // Clip offscreen to face oval

    offCtx.save();
    offCtx.translate(w, 0);
    offCtx.scale(-1, 1);
    offCtx.filter = filterString;
    offCtx.drawImage(video, 0, 0, w, h);
    offCtx.filter = "none";
    offCtx.restore();

    // 4. APPLY REGION-SPECIFIC ENHANCEMENTS ON OFFSCREEN
    if (skinWashAlpha > 0) {
        offCtx.save();
        offCtx.globalCompositeOperation = skinWashOp;
        offCtx.globalAlpha = skinWashAlpha;
        offCtx.fillStyle = skinWash;
        offCtx.fillRect(0, 0, w, h);
        offCtx.restore();
    }
    
    // Enhance Eyes (Brighter, larger appearance)
    if (style === "movie3d" || style === "pixar" || style === "anime") {
        offCtx.save();
        offCtx.beginPath();
        drawRegionPath(offCtx, landmarks, LEFT_EYE, w, h);
        drawRegionPath(offCtx, landmarks, RIGHT_EYE, w, h);
        offCtx.clip();
        
        offCtx.translate(w, 0);
        offCtx.scale(-1, 1);
        offCtx.filter = "brightness(1.4) contrast(1.4) saturate(1.3)";
        offCtx.drawImage(video, 0, 0, w, h);
        offCtx.filter = "none";
        offCtx.restore();
    }
    
    // Add Rosy Cheeks for 3D Movie/Pixar
    if (style === "movie3d" || style === "pixar") {
        const leftCheek = landmarks[117]; // Left cheek
        const rightCheek = landmarks[346]; // Right cheek
        
        const drawCheek = (cx: number, cy: number) => {
            const grad = offCtx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.1);
            grad.addColorStop(0, "rgba(255, 100, 100, 0.4)");
            grad.addColorStop(1, "rgba(255, 100, 100, 0)");
            offCtx.fillStyle = grad;
            offCtx.fillRect(cx - h*0.1, cy - h*0.1, h*0.2, h*0.2);
        };
        
        offCtx.save();
        offCtx.globalCompositeOperation = "multiply";
        drawCheek((1 - leftCheek.x) * w, leftCheek.y * h);
        drawCheek((1 - rightCheek.x) * w, rightCheek.y * h);
        offCtx.restore();
    }

    // Enhance Lips (Warmer, fuller)
    if (style === "movie3d" || style === "anime" || style === "portrait" || style === "pixar") {
        offCtx.save();
        offCtx.beginPath();
        drawRegionPath(offCtx, landmarks, LIPS_OUTER, w, h);
        offCtx.clip();
        
        offCtx.globalCompositeOperation = "overlay";
        offCtx.fillStyle = style === "anime" ? "rgba(255, 100, 150, 0.5)" : "rgba(255, 120, 120, 0.4)";
        offCtx.fillRect(0, 0, w, h);
        offCtx.restore();
    }
    
    // Add 3D Shading/Highlight (Nose tip)
    if (style === "movie3d" || style === "pixar") {
         const noseTip = landmarks[4];
         const nx = (1 - noseTip.x) * w;
         const ny = noseTip.y * h;
         
         const grad = offCtx.createRadialGradient(nx, ny, 0, nx, ny, h * 0.12);
         grad.addColorStop(0, "rgba(255, 255, 255, 0.35)");
         grad.addColorStop(1, "rgba(255, 255, 255, 0)");
         
         offCtx.save();
         offCtx.globalCompositeOperation = "screen";
         offCtx.fillStyle = grad;
         offCtx.fillRect(0, 0, w, h);
         offCtx.restore();
    }
    
    offCtx.restore(); // Restore offCtx from face oval clip

    // 5. DRAW OFFSCREEN RESULT TO MAIN CTX
    mainCtx.save();
    mainCtx.globalAlpha = presence;
    mainCtx.globalCompositeOperation = "source-over";
    // Optional: feather the edges of the face mask slightly, but for now exact clip is fine.
    mainCtx.drawImage(off, 0, 0, w, h);
    mainCtx.restore();

    return true; // Face filter applied
}
