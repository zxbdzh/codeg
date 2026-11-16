import { inflateSync } from "node:zlib";

export function decodePixelPng(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("无效 PNG。");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (!width || !height || width > 4096 || height > 4096 || !channels || png[24] !== 8 || png[28] !== 0) throw new Error("不支持的页面像素格式。");
  const compressed = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw new Error("PNG 数据截断。");
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (filtered.length !== (stride + 1) * height) throw new Error("页面像素长度不一致。");
  const pixels = Buffer.allocUnsafe(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = filtered[row * (stride + 1)];
    if (filter > 4) throw new Error("PNG 滤波无效。");
    for (let column = 0; column < stride; column++) {
      const index = row * stride + column;
      const left = column >= channels ? pixels[index - channels] : 0;
      const above = row ? pixels[index - stride] : 0;
      const diagonal = row && column >= channels ? pixels[index - stride - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = (left + above) >>> 1;
      else if (filter === 4) {
        const estimate = left + above - diagonal;
        const first = Math.abs(estimate - left), second = Math.abs(estimate - above), third = Math.abs(estimate - diagonal);
        prediction = first <= second && first <= third ? left : second <= third ? above : diagonal;
      }
      pixels[index] = (filtered[row * (stride + 1) + 1 + column] + prediction) & 255;
    }
  }
  if (channels === 3) return { width, height, data: pixels };
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = pixels[pixel * 4 + 3];
    // 页面通常不透明；透明边缘按浏览器查看面的白底合成。
    for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.round((pixels[pixel * 4 + channel] * alpha + 255 * (255 - alpha)) / 255);
  }
  return { width, height, data: rgb };
}
