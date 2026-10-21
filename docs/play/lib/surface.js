// Tiny drawing surface abstraction so the SpectraCode renderer can target a
// real canvas in the browser and a plain RGBA buffer in tests / workers.

export class CanvasSurface {
  constructor(ctx) {
    this.ctx = ctx;
  }

  fillRect(x, y, w, h, [r, g, b]) {
    this.ctx.fillStyle = `rgb(${r},${g},${b})`;
    this.ctx.fillRect(x, y, w, h);
  }

  fillCircle(cx, cy, radius, [r, g, b]) {
    this.ctx.fillStyle = `rgb(${r},${g},${b})`;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }
}

export class BufferSurface {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = 255;
  }

  fillRect(x, y, w, h, colour) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.set(px, py, colour);
    }
  }

  fillCircle(cx, cy, radius, colour) {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(px, py, colour);
      }
    }
  }

  /** ImageData-compatible view. */
  toImageData() {
    return { data: this.data, width: this.width, height: this.height };
  }
}
