import { QrCode } from './vendor/qrcodegen-v1.8.0.js';

const border = 4;
const encode = text => QrCode.encodeText(text, QrCode.Ecc.MEDIUM);

export function qrSvg(text) {
  const qr = encode(text);
  const size = qr.size + border * 2;
  const cells = [];
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.getModule(x, y)) cells.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Scan to open tournament signup" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}

export function saveQrPng(text, filename) {
  const qr = encode(text);
  const scale = 12;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (qr.size + border * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.getModule(x, y)) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
  }
  const link = document.createElement('a');
  link.download = filename; link.href = canvas.toDataURL('image/png');
  document.body.append(link); link.click(); link.remove();
}
