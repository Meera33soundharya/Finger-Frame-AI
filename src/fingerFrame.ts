// ============================================================
//  fingerFrame.ts
//  Pure geometry: landmark → quad computation, smoothing math
// ============================================================

export type Point = {
    x: number;
    y: number;
};

export type FingerFrame = {
    topLeft: Point;
    topRight: Point;
    bottomRight: Point;
    bottomLeft: Point;
};

// MediaPipe hand landmark indices
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// ─────────────────────────────────────────────
//  Math helpers
// ─────────────────────────────────────────────

export function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerpPt(a: Point, b: Point, t: number): Point {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Unsigned shoelace area of an arbitrary polygon */
export function polygonArea(pts: Point[]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a / 2);
}

// ─────────────────────────────────────────────
//  Landmark → pixel conversion
// ─────────────────────────────────────────────

/**
 * Convert a normalised landmark to pixel coords on a mirrored canvas.
 * MediaPipe returns x=0 at the LEFT of the *camera* frame; because we
 * draw mirrored (selfie view) we flip x → (1 − lm.x).
 */
export function toPixel(
    lm: { x: number; y: number },
    canvasW: number,
    canvasH: number
): Point {
    return { x: (1 - lm.x) * canvasW, y: lm.y * canvasH };
}

// ─────────────────────────────────────────────
//  Quad computation  (ported from reference)
// ─────────────────────────────────────────────

/**
 * Given the landmark arrays for exactly two detected hands, compute the
 * four frame-corner points [leftIndex, rightIndex, rightThumb, leftThumb]
 * in anatomical order (traces a rectangle when both hands hold the "L" pose).
 *
 * Returns null when:
 *  - fewer than 2 hands detected
 *  - either hand fails the L-shape gesture gate
 *  - the resulting quad is degenerate (bowtie / near-zero area)
 *
 * @param hands       Array of 2 landmark arrays (each has 21 points)
 * @param canvasW     Canvas pixel width
 * @param canvasH     Canvas pixel height
 * @param frameActive True while a frame is already visible (relaxes gate)
 */
export function computeQuad(
    hands: Array<Array<{ x: number; y: number; z: number }>>,
    canvasW: number,
    canvasH: number,
    frameActive: boolean
): Point[] | null {
    if (hands.length < 2) return null;

    const info = hands.map((lm) => ({
        index: toPixel(lm[INDEX_TIP], canvasW, canvasH),
        thumb: toPixel(lm[THUMB_TIP], canvasW, canvasH),
        wristX: toPixel(lm[WRIST], canvasW, canvasH).x,
        // Hand scale: wrist → middle-knuckle distance is stable regardless of
        // which direction fingers are pointing (finger length foreshortens).
        scale:
            dist(
                toPixel(lm[WRIST], canvasW, canvasH),
                toPixel(lm[MIDDLE_MCP], canvasW, canvasH)
            ) + 1,
    }));

    // ── Gesture gate: thumb and index must be spread apart (the "L" shape) ──
    // Hysteresis: stricter to enter (0.75), easier to stay once active (0.2).
    const needed = frameActive ? 0.2 : 0.75;
    for (const hd of info) {
        if (dist(hd.thumb, hd.index) < hd.scale * needed) return null;
    }

    // Sort by wrist X so the left-screen hand is [0] and right-screen is [1].
    info.sort((a, b) => a.wristX - b.wristX);
    const [A, B] = info;

    // Standard pose: both index fingers UP, thumbs DOWN → rectangle cycle.
    // Flipping one hand's fingers crosses the quad into a bowtie.
    const pts: Point[] = [A.index, B.index, B.thumb, A.thumb];

    // ── Area gate: reject degenerate (bowtie / near-zero) quads ──
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const hull = [...pts].sort(
        (a, b) =>
            Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
    const minArea = frameActive ? 0.0005 : 0.005;
    if (polygonArea(hull) < canvasW * canvasH * minArea) return null;

    return pts;
}

// ─────────────────────────────────────────────
//  Legacy FingerFrame builder (kept for compat)
// ─────────────────────────────────────────────

/** @deprecated Use computeQuad instead */
export function createFingerFrame(
    leftHand: Point[],
    rightHand: Point[]
): FingerFrame | null {
    if (leftHand.length < 9 || rightHand.length < 9) return null;

    const leftIndex = leftHand[8];
    const rightIndex = rightHand[8];
    const leftThumb = leftHand[4];
    const rightThumb = rightHand[4];

    return {
        topLeft: { x: leftIndex.x, y: leftIndex.y },
        topRight: { x: rightIndex.x, y: rightIndex.y },
        bottomRight: { x: rightThumb.x, y: rightThumb.y },
        bottomLeft: { x: leftThumb.x, y: leftThumb.y },
    };
}