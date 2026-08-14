// ============================================================
//  animeFilterGL.ts
//  WebGL 2.0 implementation of the Hand-Drawn Anime filter
// ============================================================

let gl: WebGL2RenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let program: WebGLProgram | null = null;
let positionBuffer: WebGLBuffer | null = null;
let texCoordBuffer: WebGLBuffer | null = null;
let texture: WebGLTexture | null = null;
let resolutionLocation: WebGLUniformLocation | null = null;
let timeLocation: WebGLUniformLocation | null = null;

const VERTEX_SHADER_SRC = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;
out vec4 outColor;

// Color quantization (Posterization)
vec3 quantize(vec3 color, float levels) {
    return floor(color * levels + 0.5) / levels;
}

// Simple edge detection (Sobel)
float sobelEdge(sampler2D tex, vec2 uv, vec2 texelSize) {
    vec3 tl = texture(tex, uv + vec2(-texelSize.x, -texelSize.y)).rgb;
    vec3 tc = texture(tex, uv + vec2(0.0, -texelSize.y)).rgb;
    vec3 tr = texture(tex, uv + vec2(texelSize.x, -texelSize.y)).rgb;
    vec3 l  = texture(tex, uv + vec2(-texelSize.x, 0.0)).rgb;
    vec3 r  = texture(tex, uv + vec2(texelSize.x, 0.0)).rgb;
    vec3 bl = texture(tex, uv + vec2(-texelSize.x, texelSize.y)).rgb;
    vec3 bc = texture(tex, uv + vec2(0.0, texelSize.y)).rgb;
    vec3 br = texture(tex, uv + vec2(texelSize.x, texelSize.y)).rgb;

    vec3 dx = tr + 2.0 * r + br - (tl + 2.0 * l + bl);
    vec3 dy = bl + 2.0 * bc + br - (tl + 2.0 * tc + tr);
    
    // Grayscale luminance for edge strength
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float valX = dot(dx, luma);
    float valY = dot(dy, luma);
    
    return min(1.0, length(vec2(valX, valY)));
}

// Fast noise for paper texture
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    vec2 texel = 1.0 / u_resolution;
    
    // 1. Base color sampling (with slight cross-blur for edge-preserving softness)
    vec3 c1 = texture(u_image, v_texCoord).rgb;
    vec3 c2 = texture(u_image, v_texCoord + vec2(texel.x, texel.y)).rgb;
    vec3 c3 = texture(u_image, v_texCoord + vec2(-texel.x, -texel.y)).rgb;
    vec3 c4 = texture(u_image, v_texCoord + vec2(texel.x, -texel.y)).rgb;
    vec3 c5 = texture(u_image, v_texCoord + vec2(-texel.x, texel.y)).rgb;
    vec3 baseColor = (c1 + c2 + c3 + c4 + c5) / 5.0;

    // 2. Color Quantization
    vec3 quantizedColor = quantize(baseColor, 8.0);
    
    // 3. Edge Detection
    float edge = sobelEdge(u_image, v_texCoord, texel);
    float edgeMask = smoothstep(0.15, 0.5, edge); // Thresholding
    
    // 4. Color adjustments (natural tone, slight desaturation, warm paper tone)
    vec3 paperTone = vec3(0.96, 0.92, 0.86); // Warm beige paper
    vec3 tintedColor = mix(quantizedColor, paperTone, 0.15); // Multiply/tint effect
    
    // 5. Ink lines
    vec3 inkColor = vec3(0.1, 0.05, 0.05); // Dark brown ink
    vec3 finalColor = mix(tintedColor, inkColor, edgeMask);
    
    // 6. Paper grain texture
    float grain = hash(v_texCoord * u_resolution + u_time) * 0.05;
    finalColor -= grain;
    
    outColor = vec4(finalColor, 1.0);
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error("Shader compile error: " + info);
    }
    return shader;
}

function initWebGL(width: number, height: number) {
    if (glCanvas) {
        if (glCanvas.width !== width || glCanvas.height !== height) {
            glCanvas.width = width;
            glCanvas.height = height;
            gl?.viewport(0, 0, width, height);
        }
        return gl!;
    }

    glCanvas = document.createElement("canvas");
    glCanvas.width = width;
    glCanvas.height = height;
    
    gl = glCanvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL 2 not supported");

    const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    
    program = gl.createProgram();
    if (!program) throw new Error("Could not create program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error("Program link error: " + gl.getProgramInfoLog(program));
    }

    // Geometry (Full screen quad)
    const positions = new Float32Array([
        -1.0, -1.0,   1.0, -1.0,   -1.0, 1.0,
        -1.0,  1.0,   1.0, -1.0,    1.0, 1.0
    ]);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const texCoords = new Float32Array([
        0.0, 1.0,   1.0, 1.0,   0.0, 0.0,
        0.0, 0.0,   1.0, 1.0,   1.0, 0.0
    ]);
    texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(program);
    
    const posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const texLoc = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(texLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    timeLocation = gl.getUniformLocation(program, "u_time");

    return gl;
}

/**
 * Processes the webcam frame using a WebGL2 shader.
 * Throws an error if WebGL fails so the caller can fallback to CPU.
 */
export function processAnimeFilterGL(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    time: number
) {
    const glCtx = initWebGL(width, height);
    
    glCtx.useProgram(program);
    glCtx.uniform2f(resolutionLocation, width, height);
    glCtx.uniform1f(timeLocation, time);

    glCtx.bindTexture(glCtx.TEXTURE_2D, texture);
    glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA, glCtx.RGBA, glCtx.UNSIGNED_BYTE, sourceVideo);

    glCtx.drawArrays(glCtx.TRIANGLES, 0, 6);

    // Draw the WebGL canvas result back to the 2D context
    targetCtx.drawImage(glCanvas!, 0, 0, width, height);
}
