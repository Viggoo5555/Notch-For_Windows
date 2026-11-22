// A notification-area icon is pixels, not an API: it is lifted out of a
// screenshot of Windows' own bar, so it carries that bar's background with it.
// Drop the background — sample the corners and make anything close to that colour
// transparent — for the bar and for the panel that lists everything in the tray.

export async function keyOutIcon(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return src;
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;
  const corners = [
    0,
    (canvas.width - 1) * 4,
    (canvas.height - 1) * canvas.width * 4,
    ((canvas.height - 1) * canvas.width + canvas.width - 1) * 4,
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const index of corners) {
    r += pixels[index];
    g += pixels[index + 1];
    b += pixels[index + 2];
  }
  r /= corners.length;
  g /= corners.length;
  b /= corners.length;
  for (let i = 0; i < pixels.length; i += 4) {
    const distance =
      Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b);
    if (distance < 40) pixels[i + 3] = 0;
    else if (distance < 96) pixels[i + 3] = Math.round((pixels[i + 3] * (distance - 40)) / 56);
  }
  ctx.putImageData(frame, 0, 0);
  return canvas.toDataURL('image/png');
}
