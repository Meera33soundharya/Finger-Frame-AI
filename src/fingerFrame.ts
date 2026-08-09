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
//  Quad computation
// ─────────────────────────────────────────────

// Additional landmark indices used for single-hand mode
const INDEX_MCP = 5;   // index finger knuckle base
const PINKY_MCP = 17;  // pinky knuckle base

/**
 * Build a stable quad from a SINGLE hand's landmarks.
 * Uses the palm base (wrist + pinky-MCP + index-MCP) and fingertips
 * to create a roughly rectangular frame region.
 */
function singleHandQuad(
    lm: Array<{ x: number; y: number; z: number }>,
    canvasW: number,
    canvasH: number
): Point[] | null {
    const wrist    = toPixel(lm[WRIST],      canvasW, canvasH);
    const indexMcp = toPixel(lm[INDEX_MCP],  canvasW, canvasH);
    const pinkyMcp = toPixel(lm[PINKY_MCP],  canvasW, canvasH);
    const indexTip = toPixel(lm[INDEX_TIP],  canvasW, canvasH);
    const thumbTip = toPixel(lm[THUMB_TIP],  canvasW, canvasH);

    // Estimate hand size
    const palmW = dist(indexMcp, pinkyMcp);
    const palmH = dist(wrist, indexMcp);
    const handSize = Math.max(palmW, palmH);

    // Need a minimum hand size (not too far from camera)
    if (handSize < canvasW * 0.04) return null;

    // Build a rectangle that spans from wrist area to fingertips
    // Use bounding box of thumb, index, and palm points, padded slightly
    const allPts = [wrist, indexMcp, pinkyMcp, indexTip, thumbTip];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of allPts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }

    // Pad by 15% on each side so the filter image has breathing room
    const padX = (maxX - minX) * 0.15;
    const padY = (maxY - minY) * 0.15;
    minX -= padX; maxX += padX;
    minY -= padY; maxY += padY;

    // Reject if still too small
    const area = (maxX - minX) * (maxY - minY);
    if (area < canvasW * canvasH * 0.005) return null;

    // Return as TL, TR, BR, BL
    return [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ];
}

/**
 * Given the landmark arrays for 1 or 2 detected hands, compute the
 * four frame-corner quad points.
 *
 * TWO HANDS: index-finger tips + thumb tips form a rectangular frame
 *            (requires "L" pose — thumbs and index spread apart).
 * ONE HAND:  palm bounding box used as the filter region.
 *
 * Returns null when the quad is degenerate or hands not visible.
 *
 * @param hands       Array of 1–2 landmark arrays (each has 21 points)
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
    if (hands.length === 0) return null;

    // ── Single-hand mode ──────────────────────────────────────────
    if (hands.length === 1) {
        return singleHandQuad(hands[0], canvasW, canvasH);
    }

    // ── Two-hand frame mode ───────────────────────────────────────
    const info = hands.map((lm) => ({
        index: toPixel(lm[INDEX_TIP], canvasW, canvasH),
        thumb: toPixel(lm[THUMB_TIP], canvasW, canvasH),
        wristX: toPixel(lm[WRIST], canvasW, canvasH).x,
        scale:
            dist(
                toPixel(lm[WRIST], canvasW, canvasH),
                toPixel(lm[MIDDLE_MCP], canvasW, canvasH)
            ) + 1,
    }));

    // Gesture gate: thumb and index must be spread (the "L" shape).
    // Hysteresis: stricter to enter (0.6), easier to stay once active (0.15).
    const needed = frameActive ? 0.15 : 0.6;
    let gestureOk = true;
    for (const hd of info) {
        if (dist(hd.thumb, hd.index) < hd.scale * needed) {
            gestureOk = false;
            break;
        }
    }

    // If L-gesture fails, fall back to single-hand mode with the first hand
    if (!gestureOk) {
        return singleHandQuad(hands[0], canvasW, canvasH);
    }

    // Sort by wrist X: left-screen hand [0], right-screen hand [1]
    info.sort((a, b) => a.wristX - b.wristX);
    const [A, B] = info;

    // Build rect: index tips = top corners, thumb tips = bottom corners
    const pts: Point[] = [A.index, B.index, B.thumb, A.thumb];

    // Area gate: reject degenerate quads
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const hull = [...pts].sort(
        (a, b) =>
            Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
    const minArea = frameActive ? 0.0003 : 0.003;
    if (polygonArea(hull) < canvasW * canvasH * minArea) {
        // Degenerate two-hand quad → fall back to single hand
        return singleHandQuad(hands[0], canvasW, canvasH);
    }

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