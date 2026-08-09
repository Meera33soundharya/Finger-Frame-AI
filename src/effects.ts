// ============================================================
//  effects.ts
//  Per-style canvas rendering pipelines.
//
//  Each style defines:
//   - A text prompt for AI inference
//   - A corner style for the frame overlay
//   - An accent color for glows & borders
//
//  drawFrameOutline accepts a FrameState ref that persists
//  between frames so one-shot effects (scan sweep, particle
//  burst) fire exactly once on first lock.
// ============================================================

import type { Point } from "./fingerFrame";

// ─────────────────────────────────────────────
//  Style registry
// ─────────────────────────────────────────────

export const STYLE_IDS = [
    "movie3d",
    "anime",
    "cyberpunk",
    "cyberpunk-girl",
    "watercolor",
    "sketch",
    "oil-painting",
    "ghibli",
    "pixar",
    "portrait",
] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** Corner visual style for the frame overlay */
export type CornerStyle =
    | "bracket"    // L-shaped corner brackets (3D, Pixar, Portrait)
    | "diamond"    // Rotated square diamonds (Anime)
    | "glitch"     // RGB-split glitch lines (Cyberpunk)
    | "feather"    // Soft watercolor smudge corners (Watercolor, Ghibli)
    | "sketch"     // Jittery hand-drawn corners (Sketch, Oil)

export interface StyleDef {
    id: StyleId;
    label: string;
    shortcut: string;
    accentColor: string;
    description: string;
    cornerStyle: CornerStyle;
    /** Secondary accent for gradients */
    accentColor2?: string;
}

export const STYLES: StyleDef[] = [
    {
        id: "movie3d",
        label: "3D Movie",
        shortcut: "1",
        accentColor: "#f59e0b",
        accentColor2: "#fbbf24",
        cornerStyle: "bracket",
        description: "High-quality 3D animated movie character with huge expressive glossy brown eyes, surprised expression, dark detailed hair, soft peach-pink skin tones, smooth polished 3D features, realistic glossy shading, warm cinematic lighting, refined facial details",
    },
    {
        id: "anime",
        label: "Anime",
        shortcut: "2",
        accentColor: "#ec4899",
        accentColor2: "#f472b6",
        cornerStyle: "diamond",
        description: "Refined hand-drawn anime illustration with short black hair, calm expressive eyes, clean delicate ink lines, soft beige and warm skin tones, subtle watercolor shading, fine facial details, vintage paper texture",
    },
    {
        id: "cyberpunk",
        label: "Cyber Boy",
        shortcut: "3",
        accentColor: "#06b6d4",
        accentColor2: "#a855f7",
        cornerStyle: "glitch",
        description: "Cyberpunk character with intense sharp eyes, messy black hair, futuristic techwear, neon city atmosphere, electric-blue and purple lighting, cinematic rim lighting",
    },
    {
        id: "cyberpunk-girl",
        label: "Cyber Girl",
        shortcut: "4",
        accentColor: "#f0abfc",
        accentColor2: "#e879f9",
        cornerStyle: "glitch",
        description: "Futuristic female cyberpunk character with expressive eyes, dark flowing hair, futuristic techwear, neon magenta and electric-blue lighting, cybernetic details",
    },
    {
        id: "watercolor",
        label: "Watercolor",
        shortcut: "5",
        accentColor: "#84cc16",
        accentColor2: "#a3e635",
        cornerStyle: "feather",
        description: "Traditional hand-painted watercolor portrait, delicate brush strokes, transparent watercolor washes, watercolor paper texture, soft pastel tones",
    },
    {
        id: "sketch",
        label: "Sketch",
        shortcut: "6",
        accentColor: "#94a3b8",
        accentColor2: "#cbd5e1",
        cornerStyle: "sketch",
        description: "detailed pencil sketch, hand drawn, graphite, intricate details, artistic",
    },
    {
        id: "oil-painting",
        label: "Oil Painting",
        shortcut: "7",
        accentColor: "#d97706",
        accentColor2: "#f59e0b",
        cornerStyle: "sketch",
        description: "Traditional high-quality oil painting portrait with soft natural features, warm skin tones, expressive eyes, rich layered colors, visible delicate oil brushstrokes, realistic paint texture, subtle highlights and shadows, elegant classical portrait style, museum-quality aesthetic",
    },
    {
        id: "ghibli",
        label: "Ghibli",
        shortcut: "8",
        accentColor: "#10b981",
        accentColor2: "#34d399",
        cornerStyle: "feather",
        description: "studio ghibli style, hayao miyazaki, lush green environments, soft anime shading, magical atmosphere",
    },
    {
        id: "pixar",
        label: "Pixar",
        shortcut: "9",
        accentColor: "#8b5cf6",
        accentColor2: "#a78bfa",
        cornerStyle: "bracket",
        description: "pixar style 3d render, smooth character design, subsurface scattering, highly detailed, vibrant colors",
    },
    {
        id: "portrait",
        label: "Portrait",
        shortcut: "0",
        accentColor: "#f43f5e",
        accentColor2: "#fb7185",
        cornerStyle: "bracket",
        description: "professional studio portrait photography, perfect lighting, 85mm lens, highly detailed face, sharp focus",
    },
];

// ─────────────────────────────────────────────
//  FrameState — persists across RAF frames
// ─────────────────────────────────────────────

export interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number; // 0..1, counts down to 0
    size: number;
}

export interface FrameState {
    /** Whether the frame has been locked (presence > 0.8) before */
    hasLockedOnce: boolean;
    /** Scan-line progress 0..1 (sweeps top to bottom once on lock) */
    scanProgress: number; // -1 = not started, 0..1 = running, 2 = done
    /** Particles alive from the burst */
    particles: Particle[];
    /** Per-corner bracket scale-in progress (0..1) */
    cornerIn: [number, number, number, number];
    /** Accumulated time for glitch effect */
    glitchTime: number;
    /** Last style id — used to reset scan on style change */
    lastStyleId: string;
}

export function createFrameState(): FrameState {
    return {
        hasLockedOnce: false,
        scanProgress: -1,
        particles: [],
        cornerIn: [0, 0, 0, 0],
        glitchTime: 0,
        lastStyleId: "",
    };
}

// ─────────────────────────────────────────────
//  Hex color → RGBA helper
// ─────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3
        ? h.split("").map(c => c + c).join("")
        : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, alpha: number): string {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ─────────────────────────────────────────────
//  Polygon helpers
// ─────────────────────────────────────────────

function centroid(quad: Point[]): Point {
    return {
        x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
        y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
    };
}

function polygonArea(quad: Point[]): number {
    // Shoelace
    let area = 0;
    const n = quad.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += quad[i].x * quad[j].y;
        area -= quad[j].x * quad[i].y;
    }
    return Math.abs(area) / 2;
}

// ─────────────────────────────────────────────
//  Particle helpers
// ─────────────────────────────────────────────

function spawnParticleBurst(state: FrameState, quad: Point[], _accentColor: string) {
    if (state.hasLockedOnce) return;
    state.hasLockedOnce = true;

    for (const corner of quad) {
        const c = centroid(quad);
        const baseAngle = Math.atan2(corner.y - c.y, corner.x - c.x);
        // 3 particles per corner, spread ±30°
        for (let k = -1; k <= 1; k++) {
            const angle = baseAngle + (k * Math.PI) / 6;
            const speed = 2 + Math.random() * 3;
            state.particles.push({
                x: corner.x,
                y: corner.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                size: 2 + Math.random() * 3,
            });
        }
    }
}

function updateAndDrawParticles(
    ctx: CanvasRenderingContext2D,
    state: FrameState,
    accentColor: string,
    dt: number
) {
    state.particles = state.particles.filter(p => p.life > 0);
    for (const p of state.particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.life -= dt * 1.8; // ~0.55s lifetime

        if (p.life <= 0) continue; // may have just crossed 0 this frame

        const radius = Math.max(0, p.size * p.life); // never negative
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = rgba(accentColor, p.life * 0.9);
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

// ─────────────────────────────────────────────
//  Inner glow vignette
// ─────────────────────────────────────────────

function drawInnerGlow(
    ctx: CanvasRenderingContext2D,
    quad: Point[],
    presence: number,
    t: number,
    accentColor: string
) {
    const c = centroid(quad);
    const area = polygonArea(quad);
    const r = Math.sqrt(area) * 1.1;

    // Pulse the glow alpha
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    const glowAlpha = presence * (0.12 + pulse * 0.08);

    ctx.save();

    // Clip to polygon
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.clip();

    const grad = ctx.createRadialGradient(c.x, c.y, r * 0.3, c.x, c.y, r);
    grad.addColorStop(0, rgba(accentColor, 0));
    grad.addColorStop(0.65, rgba(accentColor, 0));
    grad.addColorStop(1, rgba(accentColor, glowAlpha));
    ctx.fillStyle = grad;
    ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);

    ctx.restore();
}

// ─────────────────────────────────────────────
//  Scan-line sweep
// ─────────────────────────────────────────────

function drawScanLine(
    ctx: CanvasRenderingContext2D,
    quad: Point[],
    state: FrameState,
    dt: number,
    accentColor: string
) {
    if (state.scanProgress >= 1) return; // done
    if (state.scanProgress < 0) {
        state.scanProgress = 0; // start
    }

    state.scanProgress = Math.min(1, state.scanProgress + dt * 1.6); // ~0.62s sweep

    // Interpolate the horizontal band across the bounding box
    const minY = Math.min(...quad.map(p => p.y));
    const maxY = Math.max(...quad.map(p => p.y));
    const minX = Math.min(...quad.map(p => p.x));
    const maxX = Math.max(...quad.map(p => p.x));

    const scanY = minY + (maxY - minY) * state.scanProgress;
    const bandH = 28;

    ctx.save();
    // Clip to polygon
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.clip();

    const fade = 1 - Math.abs(state.scanProgress - 0.5) * 2; // brightest at midpoint
    const grad = ctx.createLinearGradient(0, scanY - bandH, 0, scanY + bandH);
    grad.addColorStop(0, rgba(accentColor, 0));
    grad.addColorStop(0.5, rgba(accentColor, 0.35 * fade));
    grad.addColorStop(1, rgba(accentColor, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(minX, scanY - bandH, maxX - minX, bandH * 2);

    ctx.restore();
}

// ─────────────────────────────────────────────
//  Corner styles
// ─────────────────────────────────────────────

/** Draws one L-shaped bracket corner */
function drawBracketCorner(
    ctx: CanvasRenderingContext2D,
    p: Point,
    c: Point,
    armLen: number,
    progress: number,
    accentColor: string,
    presence: number
) {
    // Direction from corner away from centroid (flip for inward-facing bracket)
    const dx = Math.sign(p.x - c.x);
    const dy = Math.sign(p.y - c.y);
    const arm = armLen * progress;

    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#fff";
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 14;
    ctx.globalAlpha = presence;

    ctx.beginPath();
    ctx.moveTo(p.x + dx * arm, p.y);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x, p.y + dy * arm);
    ctx.stroke();

    // Accent inner stroke
    ctx.strokeStyle = rgba(accentColor, 0.7);
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Corner dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 * progress, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 12;
    ctx.fill();

    ctx.restore();
}

/** Draws one diamond corner marker */
function drawDiamondCorner(
    ctx: CanvasRenderingContext2D,
    p: Point,
    progress: number,
    t: number,
    accentColor: string,
    presence: number
) {
    const size = (6 + Math.sin(t * 3) * 1.5) * progress;
    ctx.save();
    ctx.globalAlpha = presence;
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);

    ctx.beginPath();
    ctx.rect(-size / 2, -size / 2, size, size);
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 16;
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 0;
    const inner = size * 0.45;
    ctx.beginPath();
    ctx.rect(-inner / 2, -inner / 2, inner, inner);
    ctx.fill();

    ctx.restore();
}

/** Draws one feathered blob corner */
function drawFeatherCorner(
    ctx: CanvasRenderingContext2D,
    p: Point,
    _c: Point,
    progress: number,
    t: number,
    accentColor: string,
    presence: number
) {
    const r = (14 + Math.sin(t * 1.8) * 3) * progress;
    ctx.save();
    ctx.globalAlpha = presence * 0.75;

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
    grad.addColorStop(0, rgba(accentColor, 0.6));
    grad.addColorStop(0.5, rgba(accentColor, 0.2));
    grad.addColorStop(1, rgba(accentColor, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Small bright center dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 * progress, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

    ctx.restore();
}

/** Draws one sketchy corner (randomised jitter lines) */
function drawSketchCorner(
    ctx: CanvasRenderingContext2D,
    p: Point,
    c: Point,
    armLen: number,
    progress: number,
    accentColor: string,
    presence: number,
    seed: number
) {
    const dx = Math.sign(p.x - c.x);
    const dy = Math.sign(p.y - c.y);
    const arm = armLen * progress;

    ctx.save();
    ctx.globalAlpha = presence * 0.9;
    ctx.lineCap = "round";

    // Draw 2-3 slightly offset strokes per arm
    for (let pass = 0; pass < 2; pass++) {
        const jx = (Math.sin(seed * 7.3 + pass * 2.1) * 2);
        const jy = (Math.cos(seed * 5.9 + pass * 1.7) * 2);

        ctx.beginPath();
        ctx.moveTo(p.x + dx * arm + jx, p.y + jy);
        ctx.lineTo(p.x + jx, p.y + jy);
        ctx.lineTo(p.x + jx, p.y + dy * arm + jy);
        ctx.lineWidth = pass === 0 ? 2.5 : 1;
        ctx.strokeStyle = pass === 0 ? rgba(accentColor, 0.8) : "rgba(255,255,255,0.5)";
        ctx.stroke();
    }

    ctx.restore();
}

/** Draws one RGB-split glitch corner */
function drawGlitchCorner(
    ctx: CanvasRenderingContext2D,
    p: Point,
    c: Point,
    armLen: number,
    progress: number,
    _t: number,
    _accentColor: string,
    presence: number,
    state: FrameState
) {
    state.glitchTime += 0.016;
    const dx = Math.sign(p.x - c.x);
    const dy = Math.sign(p.y - c.y);
    const arm = armLen * progress;
    const glitch = Math.sin(state.glitchTime * 30) > 0.7 ? (Math.random() * 6 - 3) : 0;

    const colors = ["#ff003c", "#06b6d4", "#a855f7"];
    const offsets = [[-2, 0], [2, 1], [0, -1]];

    ctx.save();
    ctx.globalAlpha = presence * 0.9;
    ctx.lineCap = "square";

    for (let ci = 0; ci < colors.length; ci++) {
        const [ox, oy] = offsets[ci];
        ctx.beginPath();
        ctx.moveTo(p.x + dx * arm + ox + glitch, p.y + oy);
        ctx.lineTo(p.x + ox + glitch, p.y + oy);
        ctx.lineTo(p.x + ox + glitch, p.y + dy * arm + oy);
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors[ci];
        ctx.shadowColor = colors[ci];
        ctx.shadowBlur = 10;
        ctx.stroke();
    }

    // White core
    ctx.beginPath();
    ctx.moveTo(p.x + dx * arm, p.y);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x, p.y + dy * arm);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 0;
    ctx.stroke();

    ctx.restore();
}

// ─────────────────────────────────────────────
//  Main export: drawFrameOutline
// ─────────────────────────────────────────────

/**
 * Draw the animated border and corner indicators on top of the polygon.
 * Does NOT clip — runs after the effect pass so it draws over everything.
 *
 * @param state  Mutable FrameState, persisted across frames by the caller.
 * @param dt     Delta-time in seconds since last frame (for animations).
 */
export function drawFrameOutline(
    ctx: CanvasRenderingContext2D,
    quad: Point[],
    presence: number,
    t: number,
    accentColor: string,
    styleDef?: StyleDef,
    state?: FrameState,
    dt: number = 0.016
): void {
    ctx.save();
    ctx.globalAlpha = presence;

    // ── 1. Marching-ant outer border ──────────
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();

    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -(t * 40);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 6;
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.shadowBlur = 0;

    // ── 2. Accent glow border ─────────────────
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(accentColor, 0.45);
    ctx.stroke();

    ctx.restore();

    // ── 3. Inner glow ─────────────────────────
    drawInnerGlow(ctx, quad, presence, t, accentColor);

    // ── 4. Scan line (on lock) ────────────────
    if (state) {
        // Reset scan if style changed
        if (styleDef && state.lastStyleId !== styleDef.id) {
            state.lastStyleId = styleDef.id;
            state.scanProgress = -1;
            state.hasLockedOnce = false;
        }

        if (presence > 0.75 && state.scanProgress < 1) {
            drawScanLine(ctx, quad, state, dt, accentColor);
        }

        // ── 5. Particle burst ─────────────────
        if (presence > 0.85 && !state.hasLockedOnce) {
            spawnParticleBurst(state, quad, accentColor);
        }
        if (state.particles.length > 0) {
            ctx.save();
            updateAndDrawParticles(ctx, state, accentColor, dt);
            ctx.restore();
        }

        // ── 6. Corner scale-in ────────────────
        for (let i = 0; i < 4; i++) {
            state.cornerIn[i] = Math.min(1, state.cornerIn[i] + dt * 5); // 0.2s
        }
    }

    // ── 7. Per-style corner markers ───────────
    const cornerStyle = styleDef?.cornerStyle ?? "bracket";
    const armLen = Math.sqrt(polygonArea(quad)) * 0.13;
    const c = centroid(quad);

    ctx.save();
    quad.forEach((p, i) => {
        const progress = state ? state.cornerIn[i] : 1;

        switch (cornerStyle) {
            case "bracket":
                drawBracketCorner(ctx, p, c, armLen, progress, accentColor, presence);
                break;
            case "diamond":
                drawDiamondCorner(ctx, p, progress, t, accentColor, presence);
                break;
            case "glitch":
                if (state) drawGlitchCorner(ctx, p, c, armLen, progress, t, accentColor, presence, state);
                else drawBracketCorner(ctx, p, c, armLen, progress, accentColor, presence);
                break;
            case "feather":
                drawFeatherCorner(ctx, p, c, progress, t, accentColor, presence);
                break;
            case "sketch":
                drawSketchCorner(ctx, p, c, armLen, progress, accentColor, presence, i);
                break;
        }
    });
    ctx.restore();
}

// Re-export Point so callers can import from one place
export type { Point };
