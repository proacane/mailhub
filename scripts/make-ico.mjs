// 生成 Windows 用的 .ico（多尺寸 PNG 内嵌）与 512px 的 icon.png
import fs from 'node:fs';
import path from 'node:path';
import { encodePng, drawEnvelopeIcon } from './make-icons.mjs';

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(sizes) {
  const images = sizes.map((size) => ({
    size,
    png: encodePng(size, size, drawEnvelopeIcon(size))
  }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;

  images.forEach((image, index) => {
    const base = index * 16;
    entries[base] = image.size >= 256 ? 0 : image.size; // 256 记 0
    entries[base + 1] = image.size >= 256 ? 0 : image.size;
    entries[base + 2] = 0; // 调色板颜色数
    entries[base + 3] = 0; // reserved
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bpp
    entries.writeUInt32LE(image.png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

const outDir = path.resolve(process.argv[2] || 'build');
fs.mkdirSync(outDir, { recursive: true });

const ico = buildIco(SIZES);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`icon.ico ${SIZES.join('/')} ${ico.length} bytes`);

const png512 = encodePng(512, 512, drawEnvelopeIcon(512));
fs.writeFileSync(path.join(outDir, 'icon.png'), png512);
console.log(`icon.png 512x512 ${png512.length} bytes`);