// World (metres) <-> screen (CSS px) transform.
export class Camera {
  x = 1000; // world point at screen centre
  y = 1300;
  zoom = 0.4; // CSS px per metre
  vw = 1;
  vh = 1;
  minZoom = 0.15;
  maxZoom = 8;

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.vw / 2, (wy - this.y) * this.zoom + this.vh / 2];
  }
  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.zoom + this.x, (sy - this.vh / 2) / this.zoom + this.y];
  }
  /** Zoom by factor keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    this.x = wx - (sx - this.vw / 2) / this.zoom;
    this.y = wy - (sy - this.vh / 2) / this.zoom;
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
