// 生成应用图标与托盘图标（纯 Node 绘制，无第三方依赖）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 画布（带 4x4 采样抗锯齿） ---------- */

function createCanvas(width, height) {
  return { width, height, data: new Float64Array(width * height * 4) };
}

function blend(canvas, x, y, r, g, b, coverage) {
  if (coverage <= 0) return;
  const index = (y * canvas.width + x) * 4;
  const dstA = canvas.data[index + 3];
  const alpha = coverage + dstA * (1 - coverage);
  if (alpha <= 0) return;
  canvas.data[index] = (r * coverage + canvas.data[index] * dstA * (1 - coverage)) / alpha;
  canvas.data[index + 1] = (g * coverage + canvas.data[index + 1] * dstA * (1 - coverage)) / alpha;
  canvas.data[index + 2] = (b * coverage + canvas.data[index + 2] * dstA * (1 - coverage)) / alpha;
  canvas.data[index + 3] = alpha;
}

const SS = 4;

function paintShape(canvas, inside, color) {
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inside(px, py)) hits += 1;
        }
      }
      if (!hits) continue;
      const coverage = hits / (SS * SS);
      if (typeof color === 'function') {
        const c = color(x, y);
        blend(canvas, x, y, c[0], c[1], c[2], coverage * (c[3] ?? 1));
      } else {
        blend(canvas, x, y, color[0], color[1], color[2], coverage * (color[3] ?? 1));
      }
    }
  }
}

function roundRectInside(x0, y0, x1, y1, radius) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
}

function circleInside(cx, cy, radius) {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function segmentInside(ax, ay, bx, by, halfWidth) {
  return (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (x - px) ** 2 + (y - py) ** 2 <= halfWidth ** 2;
  };
}

function toRgba(canvas) {
  const buf = Buffer.alloc(canvas.width * canvas.height * 4);
  for (let i = 0; i < canvas.data.length; i += 1) {
    const value = canvas.data[i];
    buf[i] = Math.max(0, Math.min(255, Math.round(i % 4 === 3 ? value * 255 : value)));
  }
  return buf;
}

/* ---------- 图形 ---------- */

function drawEnvelopeIcon(size, options = {}) {
  const canvas = createCanvas(size, size);
  const s = size;
  const unread = Boolean(options.unread);

  // 圆角底板（竖直渐变）
  paintShape(canvas, roundRectInside(0, 0, s, s, s * 0.235), (_x, y) => {
    const t = y / s;
    return [
      91 + (67 - 91) * t,
      82 + (56 - 82) * t,
      240 + (202 - 240) * t,
      1
    ];
  });

  // 信封主体
  const left = s * 0.22;
  const right = s * 0.78;
  const top = s * 0.31;
  const bottom = s * 0.69;
  paintShape(canvas, roundRectInside(left, top, right, bottom, s * 0.045), [255, 255, 255, 1]);

  // 信封折页
  const stroke = Math.max(1.2, s * 0.042);
  paintShape(canvas, segmentInside(s * 0.255, s * 0.35, s * 0.5, s * 0.545, stroke), [79, 70, 229, 1]);
  paintShape(canvas, segmentInside(s * 0.5, s * 0.545, s * 0.745, s * 0.35, stroke), [79, 70, 229, 1]);

  if (unread) {
    const cx = s * 0.775;
    const cy = s * 0.775;
    paintShape(canvas, circleInside(cx, cy, s * 0.235), [255, 255, 255, 1]);
    paintShape(canvas, circleInside(cx, cy, s * 0.175), [239, 68, 68, 1]);
  }

  return toRgba(canvas);
}

function drawOverlayDot(size) {
  const canvas = createCanvas(size, size);
  const s = size;
  paintShape(canvas, circleInside(s / 2, s / 2, s * 0.5), [239, 68, 68, 1]);
  paintShape(canvas, circleInside(s / 2, s / 2, s * 0.18), [255, 255, 255, 1]);
  return toRgba(canvas);
}

/* ---------- 输出 ---------- */

export { encodePng, drawEnvelopeIcon, drawOverlayDot };

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = path.resolve(process.argv[2] || 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    { file: 'icon.png', size: 256, data: drawEnvelopeIcon(256) },
    { file: 'tray.png', size: 32, data: drawEnvelopeIcon(32) },
    { file: 'tray-unread.png', size: 32, data: drawEnvelopeIcon(32, { unread: true }) },
    { file: 'overlay-unread.png', size: 16, data: drawOverlayDot(16) }
  ];

  for (const target of targets) {
    const png = encodePng(target.size, target.size, target.data);
    const file = path.join(outDir, target.file);
    fs.writeFileSync(file, png);
    console.log(`${target.file} ${target.size}x${target.size} ${png.length} bytes`);
  }
}