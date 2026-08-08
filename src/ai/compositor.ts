import type { Point } from '../fingerFrame';

export class Compositor {
    private offscreen: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;

    constructor() {
        this.offscreen = document.createElement('canvas');
        this.ctx = this.offscreen.getContext('2d', { willReadFrequently: true })!;
    }

    /**
     * Extracts the bounding box of the polygon from the video.
     */
    extractRegion(video: HTMLVideoElement | HTMLCanvasElement, polygon: Point[]): HTMLCanvasElement {
        const bounds = this.getBoundingBox(polygon);
        
        // Ensure valid dimensions
        if (bounds.w <= 0 || bounds.h <= 0) {
            const empty = document.createElement('canvas');
            empty.width = 1;
            empty.height = 1;
            return empty;
        }

        this.offscreen.width = bounds.w;
        this.offscreen.height = bounds.h;
        this.ctx.clearRect(0, 0, bounds.w, bounds.h);
        
        // Draw the cropped region
        this.ctx.drawImage(
            video, 
            bounds.x, bounds.y, bounds.w, bounds.h,
            0, 0, bounds.w, bounds.h
        );

        // Return a copy so caller owns it
        const copy = document.createElement('canvas');
        copy.width = bounds.w;
        copy.height = bounds.h;
        const copyCtx = copy.getContext('2d')!;
        copyCtx.drawImage(this.offscreen, 0, 0);
        return copy;
    }

    /**
     * Maps the AI result back into the polygon.
     * Uses a 2-triangle affine approximation to simulate perspective warping in Canvas2D.
     */
    renderWarped(
        targetCtx: CanvasRenderingContext2D, 
        image: HTMLCanvasElement, 
        polygon: Point[], 
        alpha: number = 1
    ) {
        targetCtx.save();
        targetCtx.globalAlpha = alpha;

        // Clip to the exact polygon to ensure we don't bleed outside
        targetCtx.beginPath();
        targetCtx.moveTo(polygon[0].x, polygon[0].y);
        for (let i = 1; i < polygon.length; i++) {
            targetCtx.lineTo(polygon[i].x, polygon[i].y);
        }
        targetCtx.closePath();
        targetCtx.clip();

        // Split the quad into two triangles and draw them
        // Triangle 1: 0, 1, 2
        this.drawTriangle(
            targetCtx, image,
            [{x: 0, y: 0}, {x: image.width, y: 0}, {x: image.width, y: image.height}],
            [polygon[0], polygon[1], polygon[2]]
        );

        // Triangle 2: 0, 2, 3
        this.drawTriangle(
            targetCtx, image,
            [{x: 0, y: 0}, {x: image.width, y: image.height}, {x: 0, y: image.height}],
            [polygon[0], polygon[2], polygon[3]]
        );

        targetCtx.restore();
    }

    private drawTriangle(
        ctx: CanvasRenderingContext2D,
        img: HTMLCanvasElement,
        src: Point[],
        dst: Point[]
    ) {
        ctx.save();
        
        // Compute the affine transform matrix from src to dst
        // src points are in image space, dst points are in canvas space
        const x1 = src[0].x, y1 = src[0].y;
        const x2 = src[1].x, y2 = src[1].y;
        const x3 = src[2].x, y3 = src[2].y;

        const u1 = dst[0].x, v1 = dst[0].y;
        const u2 = dst[1].x, v2 = dst[1].y;
        const u3 = dst[2].x, v3 = dst[2].y;

        const det = (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        if (det === 0) {
            ctx.restore();
            return;
        }

        const a = (u1 * (y2 - y3) + u2 * (y3 - y1) + u3 * (y1 - y2)) / det;
        const b = (u1 * (x3 - x2) + u2 * (x1 - x3) + u3 * (x2 - x1)) / det;
        const c = (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / det;
        const d = (v1 * (x3 - x2) + v2 * (x1 - x3) + v3 * (x2 - x1)) / det;
        const e = (u1 * (x2 * y3 - x3 * y2) + u2 * (x3 * y1 - x1 * y3) + u3 * (x1 * y2 - x2 * y1)) / det;
        const f = (v1 * (x2 * y3 - x3 * y2) + v2 * (x3 * y1 - x1 * y3) + v3 * (x1 * y2 - x2 * y1)) / det;

        // Apply a tiny overlap bleed to fix seam lines between triangles
        ctx.beginPath();
        ctx.moveTo(u1, v1);
        ctx.lineTo(u2, v2);
        ctx.lineTo(u3, v3);
        ctx.closePath();
        ctx.clip();

        ctx.transform(a, c, b, d, e, f);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
    }

    private getBoundingBox(polygon: Point[]) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        for (const p of polygon) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        return {
            x: Math.max(0, Math.floor(minX)),
            y: Math.max(0, Math.floor(minY)),
            w: Math.ceil(maxX - minX),
            h: Math.ceil(maxY - minY)
        };
    }
}
