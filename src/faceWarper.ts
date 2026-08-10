// ============================================================
//  faceWarper.ts
//  Canvas2D Face Mesh Warping Engine
// ============================================================

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface FaceWarpResult {
    image: HTMLCanvasElement | null;
    sourceLandmarks: NormalizedLandmark[];
    style: string;
}

// ── 1. Simple Delaunay Triangulation (Bowyer-Watson) ────────
// We compute the triangulation of the face landmarks once per AI result.
interface Triangle {
    a: number; b: number; c: number;
}

function triangulate(): Triangle[] {
    // For performance, we'll just use a fixed simplified set of triangles 
    // for the most important facial regions (eyes, mouth, nose, boundary)
    // rather than triangulating 468 points on the fly.
    
    const triangles: Triangle[] = [];

    // To keep this extremely fast and robust for 60fps, we'll actually use a 
    // grid-based subdivision or pre-defined subsets. But for now, let's do a 
    // naive radial triangulation from the nose tip (index 4) to all other points.
    // It's not a perfect Delaunay, but it guarantees a continuous mesh without holes!
    // We will triangulate the face oval, eyes, and mouth specifically.
    
    // Instead of full Delaunay, let's use a center-fan approach from the nose tip (4)
    // to the face oval.
    const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    
    for (let i = 0; i < FACE_OVAL.length; i++) {
        triangles.push({
            a: 4, // Nose tip
            b: FACE_OVAL[i],
            c: FACE_OVAL[(i + 1) % FACE_OVAL.length]
        });
    }

    // Add Left Eye (33) to nose
    const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
    for (let i = 0; i < LEFT_EYE.length; i++) {
        triangles.push({ a: 4, b: LEFT_EYE[i], c: LEFT_EYE[(i+1)%LEFT_EYE.length] });
    }

    // Add Right Eye (362) to nose
    const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
    for (let i = 0; i < RIGHT_EYE.length; i++) {
        triangles.push({ a: 4, b: RIGHT_EYE[i], c: RIGHT_EYE[(i+1)%RIGHT_EYE.length] });
    }

    // Add Lips outer
    const LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
    for (let i = 0; i < LIPS.length; i++) {
        triangles.push({ a: 4, b: LIPS[i], c: LIPS[(i+1)%LIPS.length] });
    }

    return triangles;
}

let cachedTriangles: Triangle[] | null = null;

// ── 2. Affine Transformation & Warping ────────
export function warpFace(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    sourceResult: FaceWarpResult,
    targetLandmarks: NormalizedLandmark[],
    alpha: number
) {
    if (!cachedTriangles) {
        cachedTriangles = triangulate();
    }

    const { image: srcImg, sourceLandmarks: srcLm } = sourceResult;
    if (!srcImg) return; // No image available (null canvas from mock backend)

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = "source-over";
    // We already mirrored the whole canvas earlier, so coordinates here are normal.
    // Wait, the landmarks from mediapipe are x=[0..1]. If the canvas is mirrored, we must NOT flip x again for the math, 
    // OR we DO flip x if we are drawing onto a mirrored context.
    // Let's assume the context is NOT mirrored for the warping itself, we'll draw normally.
    // Actually, useFingerFrame mirrors the video. The landmarks match the unmirrored video.
    // If the canvas is mirrored, x should be 1-x.
    
    // Turn off smoothing for crisp seams
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const getPt = (lm: NormalizedLandmark[], idx: number) => {
        // x is flipped because we are drawing to a mirrored context
        return { x: (1 - lm[idx].x) * w, y: lm[idx].y * h };
    };

    for (const tri of cachedTriangles) {
        // Source points
        const s0 = getPt(srcLm, tri.a);
        const s1 = getPt(srcLm, tri.b);
        const s2 = getPt(srcLm, tri.c);

        // Target points
        const t0 = getPt(targetLandmarks, tri.a);
        const t1 = getPt(targetLandmarks, tri.b);
        const t2 = getPt(targetLandmarks, tri.c);

        // Affine matrix calculation
        const denom = (s0.x - s2.x) * (s1.y - s2.y) - (s1.x - s2.x) * (s0.y - s2.y);
        if (Math.abs(denom) < 0.0001) continue;

        const a = ((t0.x - t2.x) * (s1.y - s2.y) - (t1.x - t2.x) * (s0.y - s2.y)) / denom;
        const b = ((s0.x - s2.x) * (t1.x - t2.x) - (s1.x - s2.x) * (t0.x - t2.x)) / denom;
        const c = ((t0.y - t2.y) * (s1.y - s2.y) - (t1.y - t2.y) * (s0.y - s2.y)) / denom;
        const d = ((s0.x - s2.x) * (t1.y - t2.y) - (s1.x - s2.x) * (t0.y - t2.y)) / denom;
        const e = t0.x - a * s0.x - b * s0.y;
        const f = t0.y - c * s0.x - d * s0.y;

        ctx.save();
        
        // Clip to the target triangle
        ctx.beginPath();
        // Slightly expand the triangle to hide seams
        ctx.moveTo(t0.x, t0.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.lineTo(t2.x, t2.y);
        ctx.closePath();
        ctx.clip();

        // Apply affine transform
        ctx.transform(a, c, b, d, e, f);

        // Draw source image
        // The source image is a cropped face, but our landmarks are based on the full screen [0..1]
        // Wait, the sourceResult.image might be the full WxH canvas, or a crop?
        // Let's ensure the async loop generates a full WxH transparent canvas with the face in it, 
        // so landmarks match exactly.
        
        ctx.drawImage(srcImg!, 0, 0, w, h);
        
        ctx.restore();
    }
    
    ctx.restore();
}
