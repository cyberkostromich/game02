import { CIV, INFECTED, RECRUIT, ZOMBIE, type World } from '../sim/world';
import type { Camera } from './camera';

// Draws every civilian/zombie as one GL point: a single draw call for 50k+ agents.
const VS = `#version 300 es
in vec2 a_pos;
in float a_kind;
uniform vec2 u_cam;    // world point at screen centre
uniform vec2 u_scale;  // metres -> clip space
uniform float u_size;
out float v_kind;
void main() {
  gl_Position = vec4((a_pos - u_cam) * u_scale * vec2(1.0, -1.0), 0.0, 1.0);
  gl_PointSize = a_kind > 2.5 && a_kind < 3.5 ? u_size * 1.6 : (a_kind < 1.5 ? u_size * 0.85 : u_size * 1.15);
  v_kind = a_kind;
}`;

const FS = `#version 300 es
precision mediump float;
in float v_kind;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  vec3 c = v_kind > 3.5 ? vec3(0.45, 0.72, 1.0)
    : v_kind > 2.5 ? vec3(0.45, 1.0, 0.2)
    : v_kind > 1.5 ? vec3(0.85, 0.93, 0.62)
    : vec3(0.78, 0.76, 0.70);
  float a = smoothstep(0.5, 0.32, r);
  o = vec4(c * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

const cache = new WeakMap<HTMLCanvasElement, AgentRenderer>();

export class AgentRenderer {
  /** One renderer per canvas: a canvas has only one GL context to give. */
  static for(canvas: HTMLCanvasElement): AgentRenderer {
    let r = cache.get(canvas);
    if (!r) cache.set(canvas, (r = new AgentRenderer(canvas)));
    return r;
  }

  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private buf: WebGLBuffer;
  private data = new Float32Array(0);
  private uCam: WebGLUniformLocation;
  private uScale: WebGLUniformLocation;
  private uSize: WebGLUniformLocation;

  private constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.bindAttribLocation(p, 1, 'a_kind');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    this.uCam = gl.getUniformLocation(p, 'u_cam')!;
    this.uScale = gl.getUniformLocation(p, 'u_scale')!;
    this.uSize = gl.getUniformLocation(p, 'u_size')!;
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** alpha: interpolation factor between the previous and current sim tick. */
  draw(w: World, cam: Camera, dpr: number, alpha: number): void {
    const { gl } = this;
    const n = w.n;
    if (this.data.length < n * 3) this.data = new Float32Array(Math.max(n * 3, 3 * 1024) * 1.5);
    const d = this.data;
    let m = 0;
    // zombies last so they render on top of the crowd
    for (const pass of [CIV, INFECTED, RECRUIT, ZOMBIE]) {
      for (let i = 0; i < n; i++) {
        if (w.kind[i] !== pass) continue;
        d[m++] = w.px[i] + (w.x[i] - w.px[i]) * alpha;
        d[m++] = w.py[i] + (w.y[i] - w.py[i]) * alpha;
        d[m++] = pass;
      }
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (m === 0) return;
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, m), gl.STREAM_DRAW);
    gl.uniform2f(this.uCam, cam.x, cam.y);
    gl.uniform2f(this.uScale, (2 * cam.zoom) / cam.vw, (2 * cam.zoom) / cam.vh);
    gl.uniform1f(this.uSize, Math.max(2, Math.min(14, cam.zoom * 1.7)) * dpr);
    gl.drawArrays(gl.POINTS, 0, m / 3);
  }
}
