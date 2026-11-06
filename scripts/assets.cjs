'use strict';
// Original, code-drawn frame illustrations. No user photo or brand artwork.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const app = path.resolve(__dirname, '../app');
function crc32(data) { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) { const t = Buffer.from(type), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(body.length); tail.writeUInt32BE(crc32(Buffer.concat([t, body]))); return Buffer.concat([head, t, body, tail]); }
function png(width, height, sample) {
  const data = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = sample(x / width, y / height);
    for (let k = 0; k < 3; k++) data[y * (width * 3 + 1) + 1 + x * 3 + k] = Math.max(0, Math.min(255, Math.round(color[k])));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
function scene(x, y, driver) {
  let color = driver ? [255,255,255] : [239 - y * 18, 236 - y * 17, 226 - y * 18];
  if (!driver && y > 0.82) color = [179 - (y - 0.82) * 40, 151 - (y - 0.82) * 35, 123 - (y - 0.82) * 30];
  const left = driver ? 0.08 : 0.15, top = driver ? 0.25 : 0.19, w = driver ? 0.84 : 0.70, h = driver ? 0.49 : 0.60;
  if (x > left + 0.012 && x < left + w + 0.014 && y > top + 0.018 && y < top + h + 0.025) color = driver ? [231,232,230] : [183,181,170];
  if (x > left && x < left + w && y > top && y < top + h) {
    const u = (x-left)/w, v = (y-top)/h;
    color = [38 + u*10, 40 + u*10, 38 + u*10];
    if (u > 0.035 && u < 0.965 && v > 0.05 && v < 0.95) {
      color = [155-v*20, 194-v*15, 203-v*5];
      if ((u-0.75)**2 + ((v-0.27)*h/w)**2 < 0.004) color = [250,222,158];
      if (v > 0.55 + 0.13*Math.sin(u*7)) color = [105,140,137];
      if (v > 0.71 + 0.08*Math.cos(u*8)) color = [58,101,91];
      if (v > 0.85 + 0.04*Math.sin(u*12)) color = [41,76,65];
    }
  }
  return color;
}
for (const [file, width, height, driver] of [
  ['assets/images/small.png',250,175,false], ['assets/images/large.png',500,350,false],
  ['drivers/frameo/assets/images/small.png',75,75,true], ['drivers/frameo/assets/images/large.png',500,500,true],
]) { const filename = path.join(app,file); fs.mkdirSync(path.dirname(filename),{recursive:true}); fs.writeFileSync(filename,png(width,height,(x,y)=>scene(x,y,driver))); }
console.log('Original frame illustrations generated.');
