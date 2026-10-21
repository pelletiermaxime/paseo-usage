import { encode } from "fast-png";

export type ChartSeries = { values: number[]; color: readonly [number, number, number] };

// Adapted from T3 Code's monotone cubic Hermite interpolation (MIT).
// Each provider measures from zero; providers are layered, never accumulated.
export function smooth(values: number[], steps: number) {
  if (values.length < 2) return Array.from({ length: steps + 1 }, () => values[0] ?? 0);
  const slopes = values.slice(1).map((v, i) => v - values[i]);
  const tangents = values.map((_, i) =>
    i === 0
      ? slopes[0]
      : i === values.length - 1
        ? slopes.at(-1)!
        : slopes[i - 1] * slopes[i] <= 0
          ? 0
          : (slopes[i - 1] + slopes[i]) / 2,
  );
  for (let i = 0; i < slopes.length; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i],
      b = tangents[i + 1] / slopes[i],
      length = a * a + b * b;
    if (length > 9) {
      const scale = 3 / Math.sqrt(length);
      tangents[i] = scale * a * slopes[i];
      tangents[i + 1] = scale * b * slopes[i];
    }
  }
  return Array.from({ length: steps + 1 }, (_, sample) => {
    const position = (sample / steps) * (values.length - 1),
      i = Math.min(Math.floor(position), values.length - 2),
      t = position - i;
    return Math.max(
      0,
      (2 * t ** 3 - 3 * t ** 2 + 1) * values[i] +
        (t ** 3 - 2 * t ** 2 + t) * tangents[i] +
        (-2 * t ** 3 + 3 * t ** 2) * values[i + 1] +
        (t ** 3 - t ** 2) * tangents[i + 1],
    );
  });
}
export function chartScale(series: readonly ChartSeries[]) {
  const peak = series.reduce((max, s) => s.values.reduce((m, v) => Math.max(m, v), max), 0);
  if (peak === 0) return { max: 1, ticks: [0] };
  const rawStep = peak / 4,
    magnitude = 10 ** Math.floor(Math.log10(rawStep)),
    normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function renderChartPng(
  cssWidth: number,
  cssHeight: number,
  series: readonly ChartSeries[],
  max: number,
  density = 2,
) {
  const scale = Math.min(3, Math.max(1, density), 4096 / Math.max(1, cssWidth));
  const width = Math.max(2, Math.round(cssWidth * scale)),
    height = Math.max(2, Math.round(cssHeight * scale));
  const data = new Uint8Array(width * height * 4);
  const blend = (pixel: number, color: ChartSeries["color"], alpha: number) => {
    if (alpha <= 0) return;
    const offset = pixel * 4,
      oldAlpha = data[offset + 3] / 255,
      newAlpha = alpha + oldAlpha * (1 - alpha);
    for (let c = 0; c < 3; c++)
      data[offset + c] = Math.round(
        (color[c] * alpha + data[offset + c] * oldAlpha * (1 - alpha)) / newAlpha,
      );
    data[offset + 3] = Math.round(newAlpha * 255);
  };
  const layers = [...series].sort(
    (a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0),
  );
  for (const layer of layers) {
    const ys = smooth(layer.values, width - 1).map(
      (value) => height - 1 - (value / Math.max(1e-12, max)) * (height - 1 - 4 * scale),
    );
    // Paint each filled pixel exactly once. Adjacent translucent rectangles used
    // to overlap and produce the visible vertical stripes in the old renderer.
    for (let x = 0; x < width; x++) {
      const y0 = ys[x],
        y1 = ys[Math.min(width - 1, x + 1)];
      for (let y = Math.max(0, Math.floor(Math.min(y0, y1))); y < height; y++) {
        const coverage =
          (clamp(y + 1 - (y0 * 0.75 + y1 * 0.25)) + clamp(y + 1 - (y0 * 0.25 + y1 * 0.75))) / 2;
        blend(y * width + x, layer.color, coverage * 0.09);
      }
    }
    // Union antialiased stroke coverage before compositing so joins cannot
    // darken or show seams. Render at display density for crisp resized curves.
    const mask = new Uint8Array(width * height),
      radius = 0.8 * scale,
      reach = radius + 0.5;
    for (let x = 0; x < width - 1; x++) {
      const y0 = ys[x],
        dy = ys[x + 1] - y0,
        lengthSquared = 1 + dy * dy;
      const firstX = Math.max(0, Math.floor(x - reach)),
        lastX = Math.min(width - 1, Math.ceil(x + 1 + reach));
      const firstY = Math.max(0, Math.floor(Math.min(y0, ys[x + 1]) - reach)),
        lastY = Math.min(height - 1, Math.ceil(Math.max(y0, ys[x + 1]) + reach));
      for (let px = firstX; px <= lastX; px++)
        for (let py = firstY; py <= lastY; py++) {
          const t = clamp((px + 0.5 - x + (py + 0.5 - y0) * dy) / lengthSquared);
          const coverage = Math.round(
            clamp(reach - Math.hypot(px + 0.5 - x - t, py + 0.5 - y0 - t * dy)) * 255,
          );
          const index = py * width + px;
          mask[index] = Math.max(mask[index], coverage);
        }
    }
    for (let pixel = 0; pixel < mask.length; pixel++)
      if (mask[pixel]) blend(pixel, layer.color, mask[pixel] / 255);
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}
export function pngDataUri(bytes: Uint8Array) {
  // No Buffer, DOM, canvas, or native graphics dependency in the client bundle.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    chunks.push(
      alphabet[a >>> 2] +
        alphabet[((a & 3) << 4) | (b >>> 4)] +
        (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >>> 6)] : "=") +
        (i + 2 < bytes.length ? alphabet[c & 63] : "="),
    );
  }
  return "data:image/png;base64," + chunks.join("");
}
