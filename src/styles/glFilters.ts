// ============================================================
//  glFilters.ts
//  WebGL-accelerated artistic filter pipeline.
//
//  Each style uses real GLSL fragment shaders for pixel-level
//  art transformation — not just CSS property changes.
//
//  Architecture:
//   1. A persistent OffscreenCanvas (or hidden <canvas>) holds
//      the WebGL context so we don't recreate it every frame.
//   2. Per-style ShaderProgram objects are compiled once and
//      cached.
//   3. applyGLFilter() uploads the current video frame as a
//      texture, runs the shader, then blits the result back
//      to the main Canvas2D context.
//   4. Returns false when WebGL is unavailable so the caller
//      falls back to the CSS pipeline in filters.ts.
// ============================================================

import type { StyleId } from "./effects";
import type { Point } from "../rendering/fingerFrameRenderer";

// ── Vertex shader (shared across all programs) ────────────────────────────────
// NOTE: v_uv.x is flipped (1.0 - a_uv.x) to match the mirrored canvas.
// The main canvas draws the webcam mirrored (scale(-1,1)), so the GL
// texture must be sampled right-to-left to stay aligned with the polygon.
const VERT_SRC = /* glsl */ `
    attribute vec2 a_pos;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        // Mirror X so filtered pixels align with the mirrored webcam canvas
        v_uv = vec2(1.0 - a_uv.x, a_uv.y);
    }
`;

// ── Per-style fragment shaders ────────────────────────────────────────────────

// Shared helpers injected at the top of every frag shader
const FRAG_HEADER = /* glsl */ `
    precision highp float;
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform float u_time;
    varying vec2 v_uv;

    vec4 tex(vec2 uv) { return texture2D(u_tex, uv); }
    vec2 px() { return 1.0 / u_res; }
`;

// ── Sketch: Sobel edge detection → pencil on paper ───────────────────────────
const FRAG_SKETCH = FRAG_HEADER + /* glsl */ `
    float luma(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)); }

    void main() {
        vec2 p = px();
        // Sample 3×3 neighbourhood
        float tl = luma(tex(v_uv + vec2(-p.x,  p.y)));
        float t  = luma(tex(v_uv + vec2( 0.0,  p.y)));
        float tr = luma(tex(v_uv + vec2( p.x,  p.y)));
        float l  = luma(tex(v_uv + vec2(-p.x,  0.0)));
        float r  = luma(tex(v_uv + vec2( p.x,  0.0)));
        float bl = luma(tex(v_uv + vec2(-p.x, -p.y)));
        float b  = luma(tex(v_uv + vec2( 0.0, -p.y)));
        float br = luma(tex(v_uv + vec2( p.x, -p.y)));

        // Sobel kernels
        float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
        float gy = -tl - 2.0*t - tr + bl + 2.0*b + br;
        float edge = sqrt(gx*gx + gy*gy);

        // Threshold and invert for pencil look
        float line = smoothstep(0.08, 0.28, edge);
        // Paper colour: warm cream
        vec3 paper = vec3(0.94, 0.91, 0.84);
        vec3 ink   = vec3(0.15, 0.12, 0.08);
        vec3 col   = mix(paper, ink, line);

        // Very subtle original colour tint on the paper areas
        vec4 orig = tex(v_uv);
        float grey = luma(orig);
        col = mix(col, col * (0.6 + grey * 0.5), 0.08);

        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Watercolor: Kuwahara filter (anisotropic painting) ───────────────────────
const FRAG_WATERCOLOR = FRAG_HEADER + /* glsl */ `
    vec4 kuwahara(int r) {
        vec2 p = px();
        vec4 mean[4];
        float variance[4];

        for (int q = 0; q < 4; q++) {
            mean[q] = vec4(0.0);
            variance[q] = 0.0;
        }

        // 4 quadrants: TL, TR, BL, BR
        float n = float((r + 1) * (r + 1));
        for (int j = -3; j <= 0; j++) {
            for (int i = -3; i <= 0; i++) {
                vec4 c = tex(v_uv + vec2(float(i), float(j)) * p);
                mean[0] += c; variance[0] += dot(c.rgb, c.rgb);
            }
        }
        for (int j = -3; j <= 0; j++) {
            for (int i = 0; i <= 3; i++) {
                vec4 c = tex(v_uv + vec2(float(i), float(j)) * p);
                mean[1] += c; variance[1] += dot(c.rgb, c.rgb);
            }
        }
        for (int j = 0; j <= 3; j++) {
            for (int i = -3; i <= 0; i++) {
                vec4 c = tex(v_uv + vec2(float(i), float(j)) * p);
                mean[2] += c; variance[2] += dot(c.rgb, c.rgb);
            }
        }
        for (int j = 0; j <= 3; j++) {
            for (int i = 0; i <= 3; i++) {
                vec4 c = tex(v_uv + vec2(float(i), float(j)) * p);
                mean[3] += c; variance[3] += dot(c.rgb, c.rgb);
            }
        }

        float minV = 1e9;
        vec4 result = tex(v_uv);
        for (int q = 0; q < 4; q++) {
            mean[q] /= n;
            float v = variance[q] / n - dot(mean[q].rgb, mean[q].rgb);
            if (v < minV) { minV = v; result = mean[q]; }
        }
        return result;
    }

    void main() {
        vec4 col = kuwahara(3);
        // Warm paper tint
        col.rgb = mix(col.rgb * 1.05, col.rgb * vec3(1.08, 1.02, 0.88), 0.4);
        // Slight desaturation
        float grey = dot(col.rgb, vec3(0.299, 0.587, 0.114));
        col.rgb = mix(col.rgb, vec3(grey), 0.18);
        gl_FragColor = vec4(col.rgb, 1.0);
    }
`;

// ── Anime: Cel-shading (posterisation) + Sobel outlines ──────────────────────
const FRAG_ANIME = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    // Kuwahara 4-quadrant painted surface
    vec3 kuwahara(vec2 uv) {
        vec2 p = px();
        float n = 16.0;

        // TL
        vec3 m0 = vec3(0.0); float v0 = 0.0;
        m0 += tex(uv + p * vec2(-3.0,-3.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-3.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-3.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-3.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0,-2.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-2.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-2.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-2.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0,-1.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-1.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-1.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-1.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0, 0.0)).rgb; m0 += tex(uv + p * vec2(-2.0, 0.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0, 0.0)).rgb; m0 += tex(uv).rgb;
        m0 /= n;
        vec3 d0 = tex(uv + p * vec2(-1.5,-1.5)).rgb - m0; v0 = dot(d0,d0);

        // TR
        vec3 m1 = vec3(0.0); float v1 = 0.0;
        m1 += tex(uv + p * vec2( 0.0,-3.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-3.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-3.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-3.0)).rgb;
        m1 += tex(uv + p * vec2( 0.0,-2.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-2.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-2.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-2.0)).rgb;
        m1 += tex(uv + p * vec2( 0.0,-1.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-1.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-1.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-1.0)).rgb;
        m1 += tex(uv).rgb;                        m1 += tex(uv + p * vec2( 1.0, 0.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0, 0.0)).rgb; m1 += tex(uv + p * vec2( 3.0, 0.0)).rgb;
        m1 /= n;
        vec3 d1 = tex(uv + p * vec2( 1.5,-1.5)).rgb - m1; v1 = dot(d1,d1);

        // BL
        vec3 m2 = vec3(0.0); float v2 = 0.0;
        m2 += tex(uv + p * vec2(-3.0, 0.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 0.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 0.0)).rgb; m2 += tex(uv).rgb;
        m2 += tex(uv + p * vec2(-3.0, 1.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 1.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 1.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 1.0)).rgb;
        m2 += tex(uv + p * vec2(-3.0, 2.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 2.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 2.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 2.0)).rgb;
        m2 += tex(uv + p * vec2(-3.0, 3.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 3.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 3.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 3.0)).rgb;
        m2 /= n;
        vec3 d2 = tex(uv + p * vec2(-1.5, 1.5)).rgb - m2; v2 = dot(d2,d2);

        // BR
        vec3 m3 = vec3(0.0); float v3 = 0.0;
        m3 += tex(uv).rgb;                        m3 += tex(uv + p * vec2( 1.0, 0.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 0.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 0.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 1.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 1.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 1.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 1.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 2.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 2.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 2.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 2.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 3.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 3.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 3.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 3.0)).rgb;
        m3 /= n;
        vec3 d3 = tex(uv + p * vec2( 1.5, 1.5)).rgb - m3; v3 = dot(d3,d3);

        vec3 result = m0;
        float minV = v0;
        if (v1 < minV) { minV = v1; result = m1; }
        if (v2 < minV) { minV = v2; result = m2; }
        if (v3 < minV) {             result = m3; }
        return result;
    }

    void main() {
        vec2 uv = v_uv;
        vec2 p = px();

        vec3 painted = kuwahara(uv);
        
        float L = luma(painted);
        L = clamp((L - 0.35) * 1.5 + 0.35, 0.0, 1.0);
        float band = floor(L * 6.0) / 6.0;

        // Warm anime palette
        vec3 b0 = vec3(0.10, 0.05, 0.15); // shadow
        vec3 b1 = vec3(0.25, 0.15, 0.25); // mid shadow
        vec3 b2 = vec3(0.70, 0.40, 0.45); // base dark skin
        vec3 b3 = vec3(0.85, 0.65, 0.55); // base skin
        vec3 b4 = vec3(0.95, 0.85, 0.75); // highlight
        vec3 b5 = vec3(1.00, 0.98, 0.95); // specular

        vec3 cel;
        if      (band < 0.17) cel = b0;
        else if (band < 0.34) cel = b1;
        else if (band < 0.50) cel = b2;
        else if (band < 0.67) cel = b3;
        else if (band < 0.84) cel = b4;
        else                  cel = b5;

        // Tint with original
        vec3 tinted = painted * vec3(1.1, 1.0, 1.05);
        vec3 col = mix(cel, clamp(tinted, 0.0, 1.0), 0.35);

        // Dilated Sobel for strong outlines
        vec2 pe = p * 1.5;
        float tl = luma(tex(uv + pe * vec2(-1.0, 1.0)).rgb);
        float tm = luma(tex(uv + pe * vec2( 0.0, 1.0)).rgb);
        float tr2= luma(tex(uv + pe * vec2( 1.0, 1.0)).rgb);
        float ml = luma(tex(uv + pe * vec2(-1.0, 0.0)).rgb);
        float mr = luma(tex(uv + pe * vec2( 1.0, 0.0)).rgb);
        float bl2= luma(tex(uv + pe * vec2(-1.0,-1.0)).rgb);
        float bm = luma(tex(uv + pe * vec2( 0.0,-1.0)).rgb);
        float br2= luma(tex(uv + pe * vec2( 1.0,-1.0)).rgb);
        float gx = -tl - 2.0*ml - bl2 + tr2 + 2.0*mr + br2;
        float gy = -tl - 2.0*tm - tr2 + bl2 + 2.0*bm + br2;
        float edgeStr = sqrt(gx*gx + gy*gy);
        float edge = smoothstep(0.05, 0.25, edgeStr);

        col = mix(col, vec3(0.08, 0.02, 0.06), edge); // dark mahogany ink

        // Anime soft glow
        float glow = smoothstep(0.6, 1.0, luma(painted));
        col += glow * vec3(0.1, 0.05, 0.2);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── Hand-Drawn Anime: Grayscale + ink hatching ────────────────────────────────
const FRAG_HAND_DRAWN_ANIME = FRAG_HEADER + /* glsl */ `
    float luma(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
        vec2 p = px();
        vec4 orig = tex(v_uv);
        float grey = luma(orig);

        // Soft grey with warm paper overlay
        vec3 paper = vec3(0.95, 0.91, 0.84);
        vec3 col = mix(paper, vec3(grey) * 0.7, 0.85);

        // Ink hatching: diagonal lines proportional to darkness
        float hatch = 0.0;
        float lineFreq = 140.0;
        if (grey < 0.5) {
            float d = fract((v_uv.x - v_uv.y) * lineFreq);
            hatch += smoothstep(0.5, 0.55, d) * (0.5 - grey);
        }
        if (grey < 0.3) {
            float d = fract((v_uv.x + v_uv.y) * lineFreq);
            hatch += smoothstep(0.5, 0.55, d) * (0.3 - grey) * 1.5;
        }
        hatch = clamp(hatch, 0.0, 1.0);

        // Sobel for contour lines
        float tl = luma(tex(v_uv + vec2(-p.x,  p.y)));
        float tr = luma(tex(v_uv + vec2( p.x,  p.y)));
        float bl = luma(tex(v_uv + vec2(-p.x, -p.y)));
        float br = luma(tex(v_uv + vec2( p.x, -p.y)));
        float l  = luma(tex(v_uv + vec2(-p.x,  0.0)));
        float r  = luma(tex(v_uv + vec2( p.x,  0.0)));
        float t2 = luma(tex(v_uv + vec2( 0.0,  p.y)));
        float b  = luma(tex(v_uv + vec2( 0.0, -p.y)));
        float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
        float gy = -tl - 2.0*t2 - tr + bl + 2.0*b + br;
        float edge = smoothstep(0.08, 0.22, sqrt(gx*gx + gy*gy));

        col = mix(col, col * (1.0 - hatch * 0.8), 1.0);
        col = mix(col, vec3(0.08, 0.06, 0.04), edge);
        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Oil Painting: Kuwahara + warm amber texture ───────────────────────────────
const FRAG_OIL_PAINTING = FRAG_HEADER + /* glsl */ `
    vec4 kuwahara(int r) {
        vec2 p = px();
        vec4 mean[4]; float variance[4];
        for (int q = 0; q < 4; q++) { mean[q] = vec4(0.0); variance[q] = 0.0; }
        float n = float((r + 1) * (r + 1));
        for (int j = -3; j <= 0; j++) { for (int i = -3; i <= 0; i++) { vec4 c = tex(v_uv + vec2(float(i), float(j)) * p); mean[0] += c; variance[0] += dot(c.rgb, c.rgb); } }
        for (int j = -3; j <= 0; j++) { for (int i = 0; i <= 3; i++) { vec4 c = tex(v_uv + vec2(float(i), float(j)) * p); mean[1] += c; variance[1] += dot(c.rgb, c.rgb); } }
        for (int j = 0; j <= 3; j++) { for (int i = -3; i <= 0; i++) { vec4 c = tex(v_uv + vec2(float(i), float(j)) * p); mean[2] += c; variance[2] += dot(c.rgb, c.rgb); } }
        for (int j = 0; j <= 3; j++) { for (int i = 0; i <= 3; i++) { vec4 c = tex(v_uv + vec2(float(i), float(j)) * p); mean[3] += c; variance[3] += dot(c.rgb, c.rgb); } }
        float minV = 1e9; vec4 result = tex(v_uv);
        for (int q = 0; q < 4; q++) { mean[q] /= n; float v = variance[q] / n - dot(mean[q].rgb, mean[q].rgb); if (v < minV) { minV = v; result = mean[q]; } }
        return result;
    }

    void main() {
        vec4 col = kuwahara(3);
        // Warm oil amber grade
        col.rgb *= vec3(1.12, 1.02, 0.80);
        col.rgb = clamp(col.rgb, 0.0, 1.0);
        // Contrast boost
        col.rgb = (col.rgb - 0.5) * 1.3 + 0.5;
        col.rgb = clamp(col.rgb, 0.0, 1.0);
        gl_FragColor = vec4(col.rgb, 1.0);
    }
`;

// ── Cyberpunk Anime BOY:
// Full anime art transformation pipeline:
//   Pass 1: Kuwahara 4-quadrant painted surface (replaces blur, gives illustrated look)
//   Pass 2: Anime skin-tone cel mapping with warm/dark bands
//   Pass 3: Dilated Sobel — thick anime ink outlines
//   Pass 4: Electric-blue / purple neon rim + chromatic aberration glow
//   Pass 5: Animated rain streaks + atmospheric mist
//   Pass 6: Cinematic vignette
const FRAG_CYBERPUNK = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    // ── Kuwahara 4-quadrant filter (radius 3) ─────────────────────────────────
    // Samples four overlapping 4×4 regions, picks the one with lowest variance.
    // This is the core technique that makes video look like illustrated paint.
    vec3 kuwahara(vec2 uv) {
        vec2 p = px();
        // We unroll 4 quadrants manually (no dynamic loops for GLSL ES compat)
        // Each quadrant is a 4×4 block: TL, TR, BL, BR
        float n = 16.0;

        // TL quadrant: offsets -3..0 x, -3..0 y
        vec3 m0 = vec3(0.0); float v0 = 0.0;
        m0 += tex(uv + p * vec2(-3.0,-3.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-3.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-3.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-3.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0,-2.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-2.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-2.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-2.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0,-1.0)).rgb; m0 += tex(uv + p * vec2(-2.0,-1.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0,-1.0)).rgb; m0 += tex(uv + p * vec2( 0.0,-1.0)).rgb;
        m0 += tex(uv + p * vec2(-3.0, 0.0)).rgb; m0 += tex(uv + p * vec2(-2.0, 0.0)).rgb;
        m0 += tex(uv + p * vec2(-1.0, 0.0)).rgb; m0 += tex(uv).rgb;
        m0 /= n;
        vec3 d0 = tex(uv + p * vec2(-1.5,-1.5)).rgb - m0; v0 = dot(d0,d0);

        // TR quadrant: offsets 0..3 x, -3..0 y
        vec3 m1 = vec3(0.0); float v1 = 0.0;
        m1 += tex(uv + p * vec2( 0.0,-3.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-3.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-3.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-3.0)).rgb;
        m1 += tex(uv + p * vec2( 0.0,-2.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-2.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-2.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-2.0)).rgb;
        m1 += tex(uv + p * vec2( 0.0,-1.0)).rgb; m1 += tex(uv + p * vec2( 1.0,-1.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0,-1.0)).rgb; m1 += tex(uv + p * vec2( 3.0,-1.0)).rgb;
        m1 += tex(uv).rgb;                        m1 += tex(uv + p * vec2( 1.0, 0.0)).rgb;
        m1 += tex(uv + p * vec2( 2.0, 0.0)).rgb; m1 += tex(uv + p * vec2( 3.0, 0.0)).rgb;
        m1 /= n;
        vec3 d1 = tex(uv + p * vec2( 1.5,-1.5)).rgb - m1; v1 = dot(d1,d1);

        // BL quadrant: offsets -3..0 x, 0..3 y
        vec3 m2 = vec3(0.0); float v2 = 0.0;
        m2 += tex(uv + p * vec2(-3.0, 0.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 0.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 0.0)).rgb; m2 += tex(uv).rgb;
        m2 += tex(uv + p * vec2(-3.0, 1.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 1.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 1.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 1.0)).rgb;
        m2 += tex(uv + p * vec2(-3.0, 2.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 2.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 2.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 2.0)).rgb;
        m2 += tex(uv + p * vec2(-3.0, 3.0)).rgb; m2 += tex(uv + p * vec2(-2.0, 3.0)).rgb;
        m2 += tex(uv + p * vec2(-1.0, 3.0)).rgb; m2 += tex(uv + p * vec2( 0.0, 3.0)).rgb;
        m2 /= n;
        vec3 d2 = tex(uv + p * vec2(-1.5, 1.5)).rgb - m2; v2 = dot(d2,d2);

        // BR quadrant: offsets 0..3 x, 0..3 y
        vec3 m3 = vec3(0.0); float v3 = 0.0;
        m3 += tex(uv).rgb;                        m3 += tex(uv + p * vec2( 1.0, 0.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 0.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 0.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 1.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 1.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 1.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 1.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 2.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 2.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 2.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 2.0)).rgb;
        m3 += tex(uv + p * vec2( 0.0, 3.0)).rgb; m3 += tex(uv + p * vec2( 1.0, 3.0)).rgb;
        m3 += tex(uv + p * vec2( 2.0, 3.0)).rgb; m3 += tex(uv + p * vec2( 3.0, 3.0)).rgb;
        m3 /= n;
        vec3 d3 = tex(uv + p * vec2( 1.5, 1.5)).rgb - m3; v3 = dot(d3,d3);

        // Pick quadrant with lowest variance (most uniform = painted region)
        vec3 result = m0;
        float minV = v0;
        if (v1 < minV) { minV = v1; result = m1; }
        if (v2 < minV) { minV = v2; result = m2; }
        if (v3 < minV) {             result = m3; }
        return result;
    }

    // ── Hash for noise / rain ─────────────────────────────────────────────────
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // ── Skin tone detection ───────────────────────────────────────────────────
    // Returns 0..1: how "skin-like" the colour is
    float skinWeight(vec3 c) {
        // Heuristic: r > g > b, warm reddish
        float warm = smoothstep(0.0, 0.3, c.r - c.b);
        float light = smoothstep(0.12, 0.85, c.r);
        float notSat = 1.0 - smoothstep(0.0, 0.6, abs(c.r - c.g) + abs(c.g - c.b));
        return clamp(warm * light * (0.4 + notSat * 0.6), 0.0, 1.0);
    }

    void main() {
        vec2 uv = v_uv;
        vec2 p  = px();

        // ── Pass 1: Kuwahara painted surface ─────────────────────────────────
        vec3 painted = kuwahara(uv);
        // Second light pass at half radius for fine detail
        vec2 ph = p * 1.5;
        vec3 fine = vec3(0.0);
        fine += tex(uv + ph * vec2(-1.0,-1.0)).rgb + tex(uv + ph * vec2( 0.0,-1.0)).rgb + tex(uv + ph * vec2( 1.0,-1.0)).rgb;
        fine += tex(uv + ph * vec2(-1.0, 0.0)).rgb + tex(uv).rgb                         + tex(uv + ph * vec2( 1.0, 0.0)).rgb;
        fine += tex(uv + ph * vec2(-1.0, 1.0)).rgb + tex(uv + ph * vec2( 0.0, 1.0)).rgb + tex(uv + ph * vec2( 1.0, 1.0)).rgb;
        fine /= 9.0;
        vec3 surface = mix(painted, fine, 0.35);

        // ── Pass 2: Anime cel-shading with skin-aware palette ────────────────
        float L = luma(surface);
        // Mild contrast crunch to push mid-tones → anime flat look
        L = clamp((L - 0.42) * 1.55 + 0.42, 0.0, 1.0);
        float band = floor(L * 7.0) / 7.0;  // 7 bands for richer gradation

        // Base cyberpunk dark palette (shadow blues, then skin, then neon)
        vec3 band0 = vec3(0.01, 0.02, 0.08);   // deep black shadow
        vec3 band1 = vec3(0.05, 0.08, 0.22);   // dark blue-indigo
        vec3 band2 = vec3(0.12, 0.18, 0.40);   // mid indigo
        vec3 band3 = vec3(0.75, 0.62, 0.52);   // anime warm skin (key tone)
        vec3 band4 = vec3(0.90, 0.78, 0.68);   // skin highlight
        vec3 band5 = vec3(0.78, 0.90, 0.98);   // cool rim highlight
        vec3 band6 = vec3(0.95, 0.98, 1.00);   // bright specular

        vec3 cel;
        if      (band < 0.143) cel = band0;
        else if (band < 0.286) cel = band1;
        else if (band < 0.429) cel = band2;
        else if (band < 0.571) cel = band3;
        else if (band < 0.714) cel = band4;
        else if (band < 0.857) cel = band5;
        else                   cel = band6;

        // Skin-tone weighting: blend warm skin bands into skin-detected areas
        float sw = skinWeight(surface);
        vec3 skinCel = mix(cel, mix(band3, band4, clamp((L - 0.45) * 3.0, 0.0, 1.0)), sw * 0.7);

        // Hue-tinted saturation from original — preserves identity
        vec3 hued = surface * vec3(0.55, 1.15, 1.60);   // teal-shift for cyber look
        vec3 skinHued = surface * vec3(1.20, 0.95, 0.85); // warm for skin
        vec3 hueTint = mix(hued, skinHued, sw);
        vec3 celResult = mix(skinCel, clamp(hueTint, 0.0, 1.0), 0.20);

        // ── Pass 3: Dilated Sobel — thick anime ink outlines ─────────────────
        // Sample at 2× pixel distance for thicker lines
        vec2 pe = p * 1.8;
        float tl = luma(tex(uv + pe * vec2(-1.0, 1.0)).rgb);
        float tm = luma(tex(uv + pe * vec2( 0.0, 1.0)).rgb);
        float tr2 = luma(tex(uv + pe * vec2( 1.0, 1.0)).rgb);
        float ml = luma(tex(uv + pe * vec2(-1.0, 0.0)).rgb);
        float mr = luma(tex(uv + pe * vec2( 1.0, 0.0)).rgb);
        float bl2 = luma(tex(uv + pe * vec2(-1.0,-1.0)).rgb);
        float bm = luma(tex(uv + pe * vec2( 0.0,-1.0)).rgb);
        float br2 = luma(tex(uv + pe * vec2( 1.0,-1.0)).rgb);
        float gx = -tl - 2.0*ml - bl2 + tr2 + 2.0*mr + br2;
        float gy = -tl - 2.0*tm - tr2 + bl2 + 2.0*bm + br2;
        float edgeStr = sqrt(gx*gx + gy*gy);
        // Lower threshold = more lines (anime has many outlines)
        float edge = smoothstep(0.04, 0.22, edgeStr);

        // Second pass at 3.5× for thin internal face lines
        vec2 pf = p * 3.5;
        float tl2 = luma(tex(uv + pf * vec2(-1.0, 1.0)).rgb);
        float tr3 = luma(tex(uv + pf * vec2( 1.0, 1.0)).rgb);
        float bl3 = luma(tex(uv + pf * vec2(-1.0,-1.0)).rgb);
        float br3 = luma(tex(uv + pf * vec2( 1.0,-1.0)).rgb);
        float ml2 = luma(tex(uv + pf * vec2(-1.0, 0.0)).rgb);
        float mr2 = luma(tex(uv + pf * vec2( 1.0, 0.0)).rgb);
        float tm2 = luma(tex(uv + pf * vec2( 0.0, 1.0)).rgb);
        float bm2 = luma(tex(uv + pf * vec2( 0.0,-1.0)).rgb);
        float gx2 = -tl2 - 2.0*ml2 - bl3 + tr3 + 2.0*mr2 + br3;
        float gy2 = -tl2 - 2.0*tm2 - tr3 + bl3 + 2.0*bm2 + br3;
        float edge2 = smoothstep(0.06, 0.25, sqrt(gx2*gx2 + gy2*gy2)) * 0.55;

        float finalEdge = clamp(edge + edge2, 0.0, 1.0);

        // ── Pass 4: Neon rim lighting + chromatic aberration glow ─────────────
        float origL = luma(surface);
        // Chromatic aberration for electric glow
        float aberr = 0.007;
        float rCh = tex(uv + vec2( aberr, 0.0)).r;
        float bCh = tex(uv + vec2(-aberr, 0.0)).b;
        float gCh = tex(uv + vec2( 0.0, aberr * 0.5)).g;

        // Specular areas get neon electric-blue glow
        float glowMask = smoothstep(0.55, 0.88, origL);
        vec3 neon = vec3(rCh * 0.05, gCh * 0.15, bCh * 0.55) * glowMask * 2.2;

        // Pulsing purple rim on bright edges (rim lighting)
        float rimEdge = smoothstep(0.70, 0.96, origL);
        float pulse = 0.75 + 0.25 * sin(u_time * 2.8);
        neon += rimEdge * pulse * vec3(0.35, 0.05, 0.90);

        // Side rim: electric cyan on left/right screen edges (cinematic)
        float sideRim = smoothstep(0.3, 0.0, abs(uv.x - 0.5));
        neon += sideRim * 0.18 * vec3(0.0, 0.8, 1.0) * rimEdge;

        // ── Pass 5: Composite cel + neon + ink ──────────────────────────────
        vec3 col = clamp(celResult + neon, 0.0, 1.0);

        // Anime ink: very dark blue-purple (not pure black)
        vec3 inkColor = vec3(0.02, 0.01, 0.10);
        col = mix(col, inkColor, finalEdge);

        // ── Pass 6: Rain streaks + atmospheric mist ──────────────────────────
        // Animated rain drops falling diagonally
        vec2 rainUV = vec2(uv.x * 0.8 + u_time * 0.03, uv.y * 12.0 + u_time * 2.2);
        float rainCell = hash(floor(rainUV));
        float rainFrac = fract(rainUV.y + rainCell * 0.7);
        float rainDrop = smoothstep(0.92, 1.0, rainFrac) * smoothstep(0.06, 0.0, fract(rainUV.x));
        // Thin rain streak
        vec2 streakUV = vec2(fract(uv.x * 35.0 + rainCell * 0.3), fract(uv.y * 1.8 + u_time * 1.5 + rainCell));
        float streak = smoothstep(0.95, 1.0, 1.0 - abs(streakUV.x - 0.5) * 22.0) * smoothstep(0.0, 0.3, streakUV.y);
        float rain = clamp(rainDrop * 0.28 + streak * 0.12, 0.0, 1.0);
        col += rain * vec3(0.15, 0.55, 0.95) * 0.45;  // blue-tinted rain

        // Atmospheric mist (bottom fog)
        float mistY = smoothstep(0.65, 1.0, uv.y);
        col = mix(col, col * 0.55 + vec3(0.04, 0.08, 0.22) * 0.45, mistY * 0.4);

        // ── Pass 7: Cinematic vignette + neon border bloom ───────────────────
        vec2 uv2 = uv - 0.5;
        float vign = 1.0 - dot(uv2, uv2) * 1.25;
        col *= max(vign, 0.0);

        // Neon border glow (purple top, blue bottom)
        float border = 1.0 - smoothstep(0.0, 0.12, min(min(uv.x, 1.0-uv.x), min(uv.y, 1.0-uv.y)));
        col += border * mix(vec3(0.55, 0.0, 0.90), vec3(0.0, 0.45, 1.0), uv.y) * 0.35;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── Cyberpunk Anime GIRL:
// Same pipeline but mapped to a magenta/violet/pink palette
const FRAG_CYBERPUNK_GIRL = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    vec3 boxBlur(vec2 uv) {
        vec2 p = px() * 2.0;
        vec3 s = vec3(0.0);
        s += tex(uv + vec2(-p.x,  p.y)).rgb;
        s += tex(uv + vec2( 0.0,  p.y)).rgb;
        s += tex(uv + vec2( p.x,  p.y)).rgb;
        s += tex(uv + vec2(-p.x,  0.0)).rgb;
        s += tex(uv               ).rgb;
        s += tex(uv + vec2( p.x,  0.0)).rgb;
        s += tex(uv + vec2(-p.x, -p.y)).rgb;
        s += tex(uv + vec2( 0.0, -p.y)).rgb;
        s += tex(uv + vec2( p.x, -p.y)).rgb;
        return s / 9.0;
    }

    void main() {
        vec2 uv = v_uv;
        vec2 p  = px();

        vec3 smooth0 = boxBlur(uv);
        vec3 sm2 = vec3(0.0);
        sm2 += tex(uv + vec2(-p.x*3.0,  0.0)).rgb;
        sm2 += tex(uv + vec2( 0.0,      p.y*3.0)).rgb;
        sm2 += tex(uv).rgb;
        sm2 += tex(uv + vec2( p.x*3.0,  0.0)).rgb;
        sm2 += tex(uv + vec2( 0.0,     -p.y*3.0)).rgb;
        sm2 /= 5.0;
        vec3 blended = mix(smooth0, sm2, 0.4);

        float L = luma(blended);
        L = clamp((L - 0.45) * 1.6 + 0.45, 0.0, 1.0);
        float band = floor(L * 6.0) / 6.0;

        // Magenta / violet palette
        vec3 celDark   = vec3(0.06, 0.01, 0.14);
        vec3 celMid    = vec3(0.22, 0.05, 0.35);
        vec3 celBase   = vec3(0.70, 0.15, 0.75);
        vec3 celLight  = vec3(0.88, 0.40, 0.90);
        vec3 celBright = vec3(1.00, 0.72, 1.00);

        vec3 cel;
        if      (band < 0.17) cel = celDark;
        else if (band < 0.34) cel = celMid;
        else if (band < 0.50) cel = celBase;
        else if (band < 0.67) cel = celLight;
        else if (band < 0.84) cel = celBright;
        else                  cel = vec3(1.0, 0.9, 1.0);

        float origL = luma(blended);
        vec3 hueTinted = blended * vec3(1.6, 0.5, 1.5);
        cel = mix(cel, clamp(hueTinted, 0.0, 1.0), 0.18);

        float tl = luma(tex(uv + vec2(-p.x,  p.y)).rgb);
        float tm = luma(tex(uv + vec2( 0.0,  p.y)).rgb);
        float tr = luma(tex(uv + vec2( p.x,  p.y)).rgb);
        float ml = luma(tex(uv + vec2(-p.x,  0.0)).rgb);
        float mr = luma(tex(uv + vec2( p.x,  0.0)).rgb);
        float bl = luma(tex(uv + vec2(-p.x, -p.y)).rgb);
        float bm = luma(tex(uv + vec2( 0.0, -p.y)).rgb);
        float br = luma(tex(uv + vec2( p.x, -p.y)).rgb);
        float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
        float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
        float edge = smoothstep(0.08, 0.28, sqrt(gx*gx + gy*gy));

        float aberr = 0.006;
        float rC = tex(uv + vec2( aberr, 0.0)).r;
        float bC = tex(uv + vec2(-aberr, 0.0)).b;
        float glow = smoothstep(0.5, 0.9, origL);
        vec3 neon = vec3(rC * 0.5, 0.0, bC * 0.2) * glow * 2.0;
        float rim = smoothstep(0.78, 1.0, origL) * (0.7 + 0.3 * sin(u_time * 3.0));
        neon += rim * vec3(1.0, 0.1, 0.9);

        vec3 col = cel + neon;
        col = clamp(col, 0.0, 1.0);
        vec3 inkColor = vec3(0.08, 0.01, 0.10);
        col = mix(col, inkColor, edge);

        vec2 uv2 = uv - 0.5;
        float vign = 1.0 - dot(uv2, uv2) * 1.1;
        col *= max(vign, 0.0);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── 3D Movie: Warm cinematic LUT + vignette ───────────────────────────────────
const FRAG_MOVIE3D = FRAG_HEADER + /* glsl */ `
    vec3 lut_warm_cinema(vec3 c) {
        // Lift shadows to warm, punch mids, cool highlights slightly
        vec3 lift    = vec3(0.04, 0.02, 0.0);
        vec3 gain    = vec3(1.18, 1.05, 0.88);
        vec3 gamma   = vec3(0.92, 0.95, 1.05);
        vec3 result  = pow(max(c * gain + lift, vec3(0.0)), 1.0 / gamma);
        // S-curve contrast
        result = result * result * (3.0 - 2.0 * result);
        return clamp(result, 0.0, 1.0);
    }

    void main() {
        vec4 orig = tex(v_uv);
        vec3 col = lut_warm_cinema(orig.rgb);

        // Vignette
        vec2 uv2 = v_uv - 0.5;
        float vign = 1.0 - dot(uv2, uv2) * 1.2;
        col *= vign;

        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Pixar: Bold saturation + subsurface scattering approximation ──────────────
const FRAG_PIXAR = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
        vec2 p = px();
        // Soft neighbourhood average (simulates SSS blurring under skin)
        vec4 blurred = vec4(0.0);
        float tw = 0.0;
        for (int j = -2; j <= 2; j++) {
            for (int i = -2; i <= 2; i++) {
                float w = exp(-float(i*i + j*j) * 0.4);
                blurred += tex(v_uv + vec2(float(i), float(j)) * p) * w;
                tw += w;
            }
        }
        blurred /= tw;

        vec4 orig = tex(v_uv);
        // Mix orig with blurred (SSS-like)
        vec3 col = mix(orig.rgb, blurred.rgb, 0.3);

        // Vibrant saturation
        float grey = luma(col);
        col = mix(vec3(grey), col, 2.0);
        col = clamp(col, 0.0, 1.0);

        // Purple tint overlay
        col = mix(col, col * vec3(0.92, 0.88, 1.16), 0.2);
        col = clamp(col, 0.0, 1.0);

        // Cartoon-style gamma lift on darks
        col = mix(col, sqrt(col), 0.15);

        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Portrait: Skin smoothing + warm bokeh vignette ───────────────────────────
const FRAG_PORTRAIT = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    bool isSkin(vec3 c) {
        return c.r > 0.35 && c.g > 0.2 && c.b > 0.1 &&
               c.r > c.g && c.r > c.b &&
               (c.r - c.b) > 0.08;
    }

    void main() {
        vec2 p = px();
        vec4 orig = tex(v_uv);

        // Bilateral-like smoothing for skin pixels
        vec4 smooth4 = vec4(0.0); float tw = 0.0;
        for (int j = -3; j <= 3; j++) {
            for (int i = -3; i <= 3; i++) {
                vec4 s = tex(v_uv + vec2(float(i), float(j)) * p);
                float dist2 = float(i*i + j*j);
                float colorDiff = distance(s.rgb, orig.rgb);
                float w = exp(-dist2 * 0.18 - colorDiff * colorDiff * 12.0);
                smooth4 += s * w; tw += w;
            }
        }
        smooth4 /= tw;

        // Only smooth skin-tone regions
        float skinMix = isSkin(orig.rgb) ? 0.55 : 0.0;
        vec3 col = mix(orig.rgb, smooth4.rgb, skinMix);

        // Warm top, cool shadow gradient
        float warmFade = v_uv.y;  // 0=top, 1=bottom
        col = mix(col * vec3(1.12, 1.05, 0.88), col * vec3(0.88, 0.92, 1.1), warmFade);

        // Vignette
        vec2 uv2 = v_uv - 0.5;
        float vign = 1.0 - dot(uv2, uv2) * 0.85;
        col *= max(vign, 0.0);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── Shader source map ─────────────────────────────────────────────────────────
// Maps CURRENT StyleId values (from effects.ts) to GLSL shaders.
// Legacy IDs are kept as fallback for any custom styles still using them.
const SHADER_SRC: Partial<Record<StyleId, string>> = {
    // ── Current style IDs (effects.ts STYLES array) ───────────────────────
    cinematic:          FRAG_PORTRAIT,          // skin-smooth + warm bokeh
    "editorial-ink":    FRAG_SKETCH,            // Sobel pencil on paper
    watercolor:         FRAG_WATERCOLOR,        // Kuwahara painting
    "film-noir":        FRAG_SKETCH,            // edge-based + will get b&w via CSS fallback
    graphite:           FRAG_SKETCH,            // pencil / graphite
    "soft-3d":          FRAG_PIXAR,             // smooth + vivid 3D look
    "cyber-editorial":  FRAG_CYBERPUNK,         // full anime+neon pipeline
    "vintage-film":     FRAG_OIL_PAINTING,      // warm Kuwahara + amber grade
    // ── Legacy IDs (kept for backward compat) ────────────────────────────
    sketch:             FRAG_SKETCH,
    anime:              FRAG_ANIME,
    "hand-drawn-anime": FRAG_HAND_DRAWN_ANIME,
    "oil-painting":     FRAG_OIL_PAINTING,
    cyberpunk:          FRAG_CYBERPUNK,
    "cyberpunk-girl":   FRAG_CYBERPUNK_GIRL,
    movie3d:            FRAG_MOVIE3D,
    pixar:              FRAG_PIXAR,
    portrait:           FRAG_PORTRAIT,
};

// ── WebGL state ───────────────────────────────────────────────────────────────

interface GLProgram {
    program: WebGLProgram;
    aPos: number;
    aUv: number;
    uTex: WebGLUniformLocation;
    uRes: WebGLUniformLocation;
    uTime: WebGLUniformLocation;
}

let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
const programs = new Map<StyleId, GLProgram>();
let quadBuf: WebGLBuffer | null = null;
let tex: WebGLTexture | null = null;

/** Returns null if WebGL is not available on this device/browser */
function getGL(): WebGLRenderingContext | null {
    if (gl) return gl;
    if (glCanvas) return null; // already failed

    glCanvas = document.createElement("canvas");
    const ctx =
        glCanvas.getContext("webgl", { alpha: false, antialias: false }) ??
        glCanvas.getContext("experimental-webgl", { alpha: false, antialias: false }) as WebGLRenderingContext | null;

    if (!ctx) {
        console.warn("[glFilters] WebGL not available — using CSS pipeline");
        return null;
    }

    gl = ctx;

    // Full-screen quad: interleaved pos(x,y) + uv(u,v)
    const data = new Float32Array([
        //  x      y     u     v
        -1.0,  1.0,  0.0,  1.0,  // TL
         1.0,  1.0,  1.0,  1.0,  // TR
        -1.0, -1.0,  0.0,  0.0,  // BL
         1.0, -1.0,  1.0,  0.0,  // BR
    ]);
    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return gl;
}

function compileShader(glCtx: WebGLRenderingContext, src: string, type: number): WebGLShader | null {
    const s = glCtx.createShader(type)!;
    glCtx.shaderSource(s, src);
    glCtx.compileShader(s);
    if (!glCtx.getShaderParameter(s, glCtx.COMPILE_STATUS)) {
        console.error("[glFilters] Shader compile error:", glCtx.getShaderInfoLog(s));
        glCtx.deleteShader(s);
        return null;
    }
    return s;
}

function getProgram(style: StyleId): GLProgram | null {
    if (programs.has(style)) return programs.get(style)!;
    const glCtx = getGL();
    if (!glCtx) return null;

    const fragSrc = SHADER_SRC[style];
    if (!fragSrc) return null;

    const vert = compileShader(glCtx, VERT_SRC, glCtx.VERTEX_SHADER);
    const frag = compileShader(glCtx, fragSrc, glCtx.FRAGMENT_SHADER);
    if (!vert || !frag) return null;

    const prog = glCtx.createProgram()!;
    glCtx.attachShader(prog, vert);
    glCtx.attachShader(prog, frag);
    glCtx.linkProgram(prog);
    if (!glCtx.getProgramParameter(prog, glCtx.LINK_STATUS)) {
        console.error("[glFilters] Program link error:", glCtx.getProgramInfoLog(prog));
        return null;
    }

    const glp: GLProgram = {
        program: prog,
        aPos: glCtx.getAttribLocation(prog, "a_pos"),
        aUv: glCtx.getAttribLocation(prog, "a_uv"),
        uTex: glCtx.getUniformLocation(prog, "u_tex")!,
        uRes: glCtx.getUniformLocation(prog, "u_res")!,
        uTime: glCtx.getUniformLocation(prog, "u_time")!,
    };
    programs.set(style, glp);
    return glp;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply a GPU-accelerated artistic filter to the quad region.
 *
 * The context is already clipped to `quad` by the caller.
 * This function:
 *  1. Uploads the current video frame to a WebGL texture
 *  2. Runs the per-style GLSL shader
 *  3. Blits the result back to the Canvas2D context
 *
 * @returns true if the filter was applied, false if WebGL is unavailable
 *          (caller should fall back to CSS pipeline)
 */
export function applyGLFilter(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    w: number,
    h: number,
    quad: Point[],
    style: StyleId,
    time: number
): boolean {
    const glCtx = getGL();
    if (!glCtx) return false;

    const prog = getProgram(style);
    if (!prog) return false;

    // Resize WebGL canvas to match
    if (glCanvas!.width !== w || glCanvas!.height !== h) {
        glCanvas!.width  = w;
        glCanvas!.height = h;
        glCtx.viewport(0, 0, w, h);
    }

    // Upload video frame as texture (mirrored — flip horizontal)
    glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
    glCtx.pixelStorei(glCtx.UNPACK_FLIP_Y_WEBGL, true);

    try {
        glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA, glCtx.RGBA, glCtx.UNSIGNED_BYTE, video);
    } catch {
        // Video not ready yet
        return false;
    }

    // Use shader program
    glCtx.useProgram(prog.program);

    // Bind quad buffer
    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, quadBuf);
    const stride = 4 * 4; // 4 floats × 4 bytes
    glCtx.enableVertexAttribArray(prog.aPos);
    glCtx.vertexAttribPointer(prog.aPos, 2, glCtx.FLOAT, false, stride, 0);
    glCtx.enableVertexAttribArray(prog.aUv);
    glCtx.vertexAttribPointer(prog.aUv, 2, glCtx.FLOAT, false, stride, 2 * 4);

    // Set uniforms
    glCtx.uniform1i(prog.uTex, 0);
    glCtx.uniform2f(prog.uRes, w, h);
    glCtx.uniform1f(prog.uTime, time);

    glCtx.drawArrays(glCtx.TRIANGLE_STRIP, 0, 4);

    // Blit back to Canvas2D — clip to the quad region bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of quad) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const bx = Math.max(0, Math.floor(minX));
    const by = Math.max(0, Math.floor(minY));
    const bw = Math.min(w - bx, Math.ceil(maxX - minX));
    const bh = Math.min(h - by, Math.ceil(maxY - minY));

    if (bw > 0 && bh > 0) {
        ctx.drawImage(glCanvas!, bx, by, bw, bh, bx, by, bw, bh);
    }

    return true;
}

/** True if the device supports WebGL (checked lazily on first call) */
export function isWebGLAvailable(): boolean {
    return getGL() !== null;
}
