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
// No Point import

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
        float edge = 1.0 - smoothstep(0.3, 0.9, edgeStr * 2.5);

        gl_FragColor = vec4(col * edge, 1.0);
    }
`;

 // ── Hand-drawn Anime: warm beige, ink lines, watercolor shading, paper texture ─
 // @ts-ignore
const _FRAG_HAND_DRAWN_ANIME = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(311.7, 127.1))) * 83251.345); }

    // Kuwahara-lite: 2×2 quadrant smoothing for painted/illustrated look
    vec3 paintSmooth(vec2 uv) {
        vec2 p = px();
        float n = 9.0;
        vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
        float v0 = 0.0, v1 = 0.0, v2 = 0.0, v3 = 0.0;
        for (int j = -2; j <= 0; j++) {
            for (int i = -2; i <= 0; i++) {
                vec3 c = tex(uv + p * vec2(float(i), float(j))).rgb;
                m0 += c; v0 += dot(c, c);
            }
        }
        for (int j = -2; j <= 0; j++) {
            for (int i = 0; i <= 2; i++) {
                vec3 c = tex(uv + p * vec2(float(i), float(j))).rgb;
                m1 += c; v1 += dot(c, c);
            }
        }
        for (int j = 0; j <= 2; j++) {
            for (int i = -2; i <= 0; i++) {
                vec3 c = tex(uv + p * vec2(float(i), float(j))).rgb;
                m2 += c; v2 += dot(c, c);
            }
        }
        for (int j = 0; j <= 2; j++) {
            for (int i = 0; i <= 2; i++) {
                vec3 c = tex(uv + p * vec2(float(i), float(j))).rgb;
                m3 += c; v3 += dot(c, c);
            }
        }
        m0 /= n; m1 /= n; m2 /= n; m3 /= n;
        v0 = v0/n - dot(m0,m0);
        v1 = v1/n - dot(m1,m1);
        v2 = v2/n - dot(m2,m2);
        v3 = v3/n - dot(m3,m3);
        float minV = min(min(v0,v1), min(v2,v3));
        if      (minV == v0) return m0;
        else if (minV == v1) return m1;
        else if (minV == v2) return m2;
        else                 return m3;
    }

    void main() {
        vec2 p = px();
        vec2 uv = v_uv;

        // 1. Painted illustrated base (Kuwahara-lite)
        vec3 painted = paintSmooth(uv);

        // 2. Beige/warm paper palette — desaturate toward warm ivory
        float grey = luma(painted);
        // Shift hue toward warm sepia: lift r/g, suppress b
        vec3 warm = vec3(
            grey * 0.96 + painted.r * 0.30,
            grey * 0.86 + painted.g * 0.22,
            grey * 0.62 + painted.b * 0.14
        );
        // Blend painted color with warm tone — keeps skin tones, mutes cold hues
        vec3 col = mix(warm, painted * vec3(1.08, 0.97, 0.80), 0.38);
        col = clamp(col, 0.0, 1.0);

        // 3. Soft watercolor wash — gentle cross-blur for bleed effect
        vec3 wash = vec3(0.0); float tw = 0.0;
        for (int j = -3; j <= 3; j++) {
            for (int i = -3; i <= 3; i++) {
                float w = exp(-float(i*i + j*j) * 0.22);
                wash += tex(uv + p * vec2(float(i)*1.8, float(j)*1.8)).rgb * w;
                tw += w;
            }
        }
        wash /= tw;
        // Convert wash to warm tones too
        float washGrey = luma(wash);
        vec3 washWarm = mix(
            vec3(washGrey*0.96, washGrey*0.86, washGrey*0.62),
            wash * vec3(1.06, 0.95, 0.78),
            0.35
        );
        col = mix(col, washWarm, 0.25); // soft watercolor bleed

        // 4. Gentle contrast lift — anime-style clear tones
        col = (col - 0.5) * 1.15 + 0.5;
        col = clamp(col, 0.0, 1.0);

        // 5. Ink line outlines — dilated Sobel on luminance
        vec2 pe = p * 1.3;
        float tl = luma(tex(uv + pe*vec2(-1.0, 1.0)).rgb);
        float tm = luma(tex(uv + pe*vec2( 0.0, 1.0)).rgb);
        float tr2= luma(tex(uv + pe*vec2( 1.0, 1.0)).rgb);
        float ml = luma(tex(uv + pe*vec2(-1.0, 0.0)).rgb);
        float mr = luma(tex(uv + pe*vec2( 1.0, 0.0)).rgb);
        float bl2= luma(tex(uv + pe*vec2(-1.0,-1.0)).rgb);
        float bm = luma(tex(uv + pe*vec2( 0.0,-1.0)).rgb);
        float br2= luma(tex(uv + pe*vec2( 1.0,-1.0)).rgb);
        float gx = -tl - 2.0*ml - bl2 + tr2 + 2.0*mr + br2;
        float gy = -tl - 2.0*tm - tr2 + bl2 + 2.0*bm + br2;
        float edgeStr = sqrt(gx*gx + gy*gy);
        // Ink is dark warm brown (not pure black)
        float inkAlpha = smoothstep(0.18, 0.55, edgeStr * 2.2);
        vec3 inkColor = vec3(0.18, 0.12, 0.08); // warm dark ink
        col = mix(col, inkColor, inkAlpha * 0.88);

        // 6. Vintage paper texture overlay
        float paperH = hash(uv * 480.0);
        float paperH2 = hash2(uv * 320.0 + 0.5);
        float paper = (paperH + paperH2) * 0.5; // averaged = smoother grain
        col *= (0.93 + paper * 0.10); // subtle brightness variation = paper fiber

        // 7. Tiny animated grain (like aged illustration)
        float grain = hash(uv * u_time * 73.0 + 0.3) - 0.5;
        col += grain * 0.018;

        // 8. Warm ivory background push (flatten very light areas toward paper color)
        float brightness = luma(col);
        vec3 paperColor = vec3(0.96, 0.92, 0.82); // vintage ivory
        col = mix(col, paperColor, smoothstep(0.78, 1.0, brightness) * 0.45);

        // 9. Soft vignette — darker warm edges
        vec2 uv2 = uv - 0.5;
        float vign = 1.0 - dot(uv2, uv2) * 1.1;
        col *= clamp(vign, 0.0, 1.0);
        // Tint vignette edges toward sepia
        col = mix(col * vec3(0.85, 0.78, 0.65), col, clamp(vign * 1.2, 0.0, 1.0));

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── Oil Painting: Kuwahara + warm amber texture + Chiaroscuro ────────────────
const FRAG_OIL_PAINTING = FRAG_HEADER + /* glsl */ `
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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
        vec2 uv = v_uv;
        // Pass 1: Painted brushstrokes via Kuwahara
        vec4 col = kuwahara(3);
        
        float lum = luma(col.rgb);
        
        // Pass 2: Classical Color Grading (Rembrandt / Vermeer palette)
        // Desaturate slightly for an antique, non-digital look
        col.rgb = mix(vec3(lum), col.rgb, 0.75);
        
        // Warm oil grade (golden midtones, deep earthy shadows)
        // Mid-tone lift (warm peach/ochre)
        col.rgb += vec3(0.08, 0.05, 0.02) * (1.0 - abs(lum - 0.5) * 2.0);
        // Shadow tint (deep umber / olive)
        col.rgb = mix(col.rgb * vec3(0.75, 0.55, 0.35), col.rgb, smoothstep(0.0, 0.4, lum));
        // Highlight tint (warm cream / ivory)
        col.rgb = mix(col.rgb, col.rgb * vec3(1.15, 1.05, 0.90), smoothstep(0.6, 1.0, lum));

        // Contrast and depth curve
        col.rgb = (col.rgb - 0.5) * 1.35 + 0.5;
        col.rgb = clamp(col.rgb, 0.0, 1.0);

        // Pass 3: Canvas & Impasto Texture
        vec2 tuv = uv * 800.0;
        // Woven canvas thread pattern
        float texX = sin(tuv.x) * cos(tuv.y * 0.5);
        float texY = sin(tuv.y) * cos(tuv.x * 0.5);
        float canvas = (texX + texY) * 0.015;
        
        // Larger paint cracks/texture (simulated impasto)
        float noise = hash(floor(uv * 400.0));
        float crackle = step(0.95, noise) * 0.05;
        
        // Apply textures to luminance
        col.rgb += canvas;
        col.rgb -= crackle * vec3(0.8, 0.6, 0.4);

        // Subtle brush grain (high frequency)
        float grain = hash(uv * 1000.0) - 0.5;
        col.rgb += grain * 0.025;

        // Pass 4: Dramatic Chiaroscuro Vignette
        // Center slightly above middle (standard portrait face height)
        float dist = distance(uv, vec2(0.5, 0.45)); 
        float vign = smoothstep(0.75, 0.25, dist);
        
        // Background falls into deep, warm, dark shadow
        vec3 darkBackground = col.rgb * vec3(0.25, 0.15, 0.08);
        col.rgb = mix(darkBackground, col.rgb, vign);

        // Add a slight luminous glow to the focal point
        float glow = smoothstep(0.35, 0.0, dist);
        col.rgb += glow * vec3(0.08, 0.05, 0.02);

        gl_FragColor = vec4(clamp(col.rgb, 0.0, 1.0), 1.0);
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
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // Fast Kuwahara for painted base
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
        vec2 uv = v_uv;
        vec2 p = px();

        // 1. Chromatic Aberration for edge color separation
        float aberr = 0.003;
        vec3 col;
        col.r = tex(uv + vec2(aberr, 0.0)).r;
        col.g = tex(uv).g;
        col.b = tex(uv - vec2(aberr, 0.0)).b;

        // Base painted surface
        vec3 painted = kuwahara(3).rgb;
        
        // Blend original sharp image with painted for detail retention
        col = mix(col, painted, 0.6);

        float lum = luma(col);

        // 2. Cyberpunk Color Grade — additive toning (no red blowout)
        // Desaturate first then selectively re-tint by luminance zone
        vec3 grey = vec3(lum);

        // Shadow zone → deep indigo/navy
        vec3 shadowCol = mix(grey, vec3(0.05, 0.03, 0.28), 0.75);
        // Midtone zone → warm magenta-violet
        vec3 midCol    = mix(col,  vec3(0.72, 0.18, 0.85), 0.45);
        // Highlight zone → electric cyan
        vec3 highCol   = mix(col,  vec3(0.30, 0.95, 1.00), 0.55);

        // Blend zones by luminance
        vec3 graded = mix(shadowCol, midCol,  smoothstep(0.0, 0.45, lum));
              graded = mix(graded,   highCol, smoothstep(0.50, 0.85, lum));

        // Modest contrast lift on the graded result
        col = (graded - 0.5) * 1.15 + 0.5;

        // 3. Neon Bloom — cyan glow only on bright highlights
        float glowMask = smoothstep(0.70, 0.95, lum);
        vec3 bloom = glowMask * vec3(0.10, 0.85, 1.00) * 0.55;
        col = clamp(col + bloom, 0.0, 1.0);

        // 4. Electric edge rim: add a faint magenta fringe near high-contrast edges
        float edgeLum = abs(lum - luma(tex(uv + p * vec2(2.0, 0.0)).rgb));
        col += edgeLum * vec3(0.9, 0.0, 0.8) * 0.4;

        // 5. Subtle scanline overlay
        float scanline = sin(uv.y * 900.0) * 0.025;
        col -= scanline;
        col = clamp(col, 0.0, 1.0);

        // 6. Cinematic vignette — deep purple-black at edges
        float dist = distance(uv, vec2(0.5, 0.45));
        float vign = smoothstep(0.80, 0.28, dist);
        vec3 vignetteCol = col * vec3(0.12, 0.03, 0.30);
        col = mix(vignetteCol, col, vign);

        // 7. Rain streaks — faint cyan trickles
        vec2 rainUV = vec2(floor(uv.x * 25.0) / 25.0, uv.y + u_time * 1.8);
        float rainNoise = hash(vec2(floor(uv.x * 25.0), floor(uv.y * 3.0)));
        float rain = smoothstep(0.96, 1.0, rainNoise) * 0.15;
        col = clamp(col + rain * vec3(0.4, 0.9, 1.0), 0.0, 1.0);

        gl_FragColor = vec4(col, 1.0);
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
export const SHADER_SRC: Record<string, string> = {
    "oil-painting":     FRAG_OIL_PAINTING,
    "cyberpunk":        FRAG_CYBERPUNK,
    "3d-anime":         FRAG_PIXAR,
    "hand-drawn-anime": FRAG_ANIME,
    "watercolor":       FRAG_WATERCOLOR,
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
        glCanvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true }) ??
        glCanvas.getContext("experimental-webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;

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
    video: HTMLVideoElement,
    w: number,
    h: number,
    style: StyleId,
    time: number
): HTMLCanvasElement | null {
    const glCtx = getGL();
    if (!glCtx) return null;

    const prog = getProgram(style);
    if (!prog) return null;

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
        return null;
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

    return glCanvas;
}

/** True if the device supports WebGL (checked lazily on first call) */
export function isWebGLAvailable(): boolean {
    return getGL() !== null;
}
