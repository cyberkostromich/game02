// World (metres) <-> screen (CSS px) transform with view rotation in whole degrees.
export class Camera {
  x = 1000; // world point at screen centre
  y = 1300;
  zoom = 0.4; // CSS px per metre
  deg = 0; // view rotation, degrees clockwise
  cos = 1;
  sin = 0;
  vw = 1;
  vh = 1;
  minZoom = 0.15;
  maxZoom = 8;

  get angle(): number {
    return (this.deg * Math.PI) / 180;
  }

  toScreen(wx: number, wy: number): [number, number] {
    const dx = (wx - this.x) * this.zoom;
    const dy = (wy - this.y) * this.zoom;
    return [dx * this.cos - dy * this.sin + this.vw / 2, dx * this.sin + dy * this.cos + this.vh / 2];
  }
  toWorld(sx: number, sy: number): [number, number] {
    const ux = (sx - this.vw / 2) / this.zoom;
    const uy = (sy - this.vh / 2) / this.zoom;
    return [ux * this.cos + uy * this.sin + this.x, -ux * this.sin + uy * this.cos + this.y];
  }
  /** World→device-pixel matrix for CanvasRenderingContext2D.setTransform. */
  matrix(dpr: number): [number, number, number, number, number, number] {
    const z = this.zoom * dpr;
    const a = z * this.cos;
    const b = z * this.sin;
    const c = -z * this.sin;
    const d = z * this.cos;
    return [a, b, c, d, (dpr * this.vw) / 2 - (a * this.x + c * this.y), (dpr * this.vh) / 2 - (b * this.x + d * this.y)];
  }
  /** World direction that points down the screen (towards the viewer in 2.5D). */
  down(): [number, number] {
    return [this.sin, this.cos];
  }
  panBy(dsx: number, dsy: number): void {
    this.x -= (dsx * this.cos + dsy * this.sin) / this.zoom;
    this.y -= (-dsx * this.sin + dsy * this.cos) / this.zoom;
  }
  /** Zoom by factor keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const [wx2, wy2] = this.toWorld(sx, sy);
    this.x += wx - wx2;
    this.y += wy - wy2;
  }
  rotate(stepDeg: number): void {
    this.deg = (((this.deg + stepDeg) % 360) + 360) % 360;
    this.cos = Math.cos(this.angle);
    this.sin = Math.sin(this.angle);
  }
  fit(w: number, h: number, margin = 0.95): void {
    this.x = w / 2;
    this.y = h / 2;
    this.zoom = Math.min(this.vw / w, this.vh / h) * margin;
    this.minZoom = this.zoom * 0.6;
  }
  clamp(w: number, h: number): void {
    this.x = Math.min(w, Math.max(0, this.x));
    this.y = Math.min(h, Math.max(0, this.y));
  }
}
