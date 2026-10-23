import { execFileSync } from "node:child_process";
import { expect, test } from "vite-plus/test";
import { decode, encode } from "fast-png";
import { chartScale, pngDataUri, renderChartPng, smooth } from "../client/chart-image";

test("charts load and render when the native decoder only supports UTF-8", () => {
  // Use a fresh process so cached dependencies cannot hide import-time failures.
  const moduleUrl = new URL("../client/chart-image.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      globalThis.TextDecoder = class extends TextDecoder {
        constructor(encoding = "utf-8") {
          if (!["utf-8", "utf8"].includes(encoding))
            throw new RangeError("Unknown encoding: " + encoding);
          super(encoding);
        }
      };
      const { renderChartPng } = await import(${JSON.stringify(moduleUrl)});
      const bytes = renderChartPng(20, 10, [{ values: [1, 2], color: [255, 0, 0] }], 2);
      process.stdout.write(Buffer.from(bytes).toString("base64"));
    `,
  ]);
  const image = decode(Buffer.from(output.toString(), "base64"));
  expect(image.width).toBe(40);
  expect(image.height).toBe(20);
  expect(Buffer.from(output.toString(), "base64")).toEqual(Buffer.from(encode(image)));
});

test("the translucent fill has uniform opacity with no vertical strip seams", () => {
  const image = decode(
    renderChartPng(120, 80, [{ values: [10, 10, 10], color: [255, 255, 255] }], 20),
  );
  const pixels = image.data as Uint8Array;
  const row = Array.from(
    { length: image.width - 4 },
    (_, i) => pixels[((image.height - 20) * image.width + i + 2) * 4 + 3],
  );
  expect(new Set(row)).toEqual(new Set([23]));
  expect(image.width).toBe(240);
  expect(image.height).toBe(160);
});
test("providers retain their own heights and colors regardless of presentation order", () => {
  const white = { values: [0, 100, 0], color: [240, 240, 240] as const };
  const orange = { values: [0, 1, 0], color: [217, 119, 87] as const };
  expect(chartScale([white, orange]).max).toBe(100);
  const encoded = renderChartPng(100, 60, [white, orange], 100);
  expect(renderChartPng(100, 60, [orange, white], 100)).toEqual(encoded);
  const image = decode(encoded),
    pixel = (8 * image.width + Math.floor(image.width / 2)) * 4;
  expect(Number(image.data[pixel])).toBeGreaterThan(230);
  expect(Number(image.data[pixel + 1])).toBeGreaterThan(230);
});
test("monotone interpolation preserves peaks and flat zero regions without overshoot", () => {
  const values = smooth([0, 0, 10, 0, 0], 400);
  expect(values.slice(0, 101).every((v) => v === 0)).toBe(true);
  expect(values[200]).toBe(10);
  expect(Math.min(...values)).toBe(0);
  expect(Math.max(...values)).toBe(10);
  expect(values.slice(100, 201).every((v, i, rising) => i === 0 || v >= rising[i - 1])).toBe(true);
});
test("image data URIs encode arbitrary PNG bytes without browser or Node globals", () => {
  for (const length of [0, 1, 2, 3, 4, 255]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i);
    expect(pngDataUri(bytes)).toBe(
      "data:image/png;base64," + Buffer.from(bytes).toString("base64"),
    );
  }
});
