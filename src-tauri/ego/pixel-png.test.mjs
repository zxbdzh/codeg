import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePixelPng } from "./pixel-png.mjs";

function chunk(name, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(name, 4); data.copy(output, 8);
  return output;
}
function image(filter) {
  const width = 16, height = 9, stride = width * 3;
  const raw = Buffer.from(Array.from({ length: stride * height }, (_, index) => (index * 37 + (index >>> 3)) & 255));
  const scan = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    scan[row * (stride + 1)] = filter;
    for (let column = 0; column < stride; column++) {
      const index = row * stride + column;
      const left = column >= 3 ? raw[index - 3] : 0, above = row ? raw[index - stride] : 0, diagonal = row && column >= 3 ? raw[index - stride - 3] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = above;
      if (filter === 3) prediction = Math.floor((left + above) / 2);
      if (filter === 4) {
        const estimate = left + above - diagonal, distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - diagonal)];
        prediction = [left, above, diagonal][distances.indexOf(Math.min(...distances))];
      }
      scan[row * (stride + 1) + 1 + column] = (raw[index] - prediction) & 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return { raw, png: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]) };
}

for (let filter = 0; filter <= 4; filter++) test(`PNG滤波${filter}逐字节重构`, () => {
  const fixture = image(filter);
  assert.deepEqual(decodePixelPng(fixture.png).data, fixture.raw);
});
test("截断、越界尺寸及不支持格式拒绝", () => {
  assert.throws(() => decodePixelPng(Buffer.alloc(10)));
  const fixture = image(0);
  assert.throws(() => decodePixelPng(fixture.png.subarray(0, 40)));
  fixture.png.writeUInt32BE(100000, 16);
  assert.throws(() => decodePixelPng(fixture.png));
});
