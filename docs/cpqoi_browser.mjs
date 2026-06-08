function rgbTo565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

function rgb565ToRgba(color) {
  const r5 = (color >>> 11) & 0x1f;
  const g6 = (color >>> 5) & 0x3f;
  const b5 = color & 0x1f;
  return [
    ((r5 << 3) | (r5 >> 2)) & 0xff,
    ((g6 << 2) | (g6 >> 4)) & 0xff,
    ((b5 << 3) | (b5 >> 2)) & 0xff,
    255,
  ];
}

function hashColor565(color) {
  return (color ^ (color >> 5) ^ (color >> 11)) % 64;
}

function pushRun(out, opcodeBase, count, longOpcode) {
  let remaining = count;
  while (remaining > 0) {
    if (remaining <= 64) {
      out.push(opcodeBase | (remaining - 1));
      remaining = 0;
    } else {
      const chunk = Math.min(remaining, 65536);
      out.push(longOpcode, (chunk - 1) & 0xff, ((chunk - 1) >>> 8) & 0xff);
      remaining -= chunk;
    }
  }
}

function flushSkip(out, count) {
  if (count > 0) {
    pushRun(out, 0x40, count, 0xfe);
  }
}

function flushRun(out, count) {
  if (count > 0) {
    pushRun(out, 0x80, count, 0xfd);
  }
}

export function rgbaImageTo565(imageInput) {
  const { width, height, data } = imageInput;
  const pixels = new Uint16Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    pixels[p] = rgbTo565(data[i], data[i + 1], data[i + 2]);
  }
  return pixels;
}

export function encodeCpqoiFrame(imageInput, previous565 = null) {
  const { width, height } = imageInput;
  const pixels565 = rgbaImageTo565(imageInput);
  const out = [0x43, 0x50, 0x51, 0x4f, width & 0xff, (width >>> 8) & 0xff, height & 0xff, (height >>> 8) & 0xff];
  const index = new Uint16Array(64);
  let prevColor = 0;
  let runCount = 0;
  let skipCount = 0;

  for (let i = 0; i < pixels565.length; i += 1) {
    const color = pixels565[i];
    const prevFrameColor = previous565 ? previous565[i] : null;

    if (previous565 && color === prevFrameColor) {
      flushRun(out, runCount);
      runCount = 0;
      skipCount += 1;
      continue;
    }

    flushSkip(out, skipCount);
    skipCount = 0;

    if (color === prevColor) {
      runCount += 1;
      continue;
    }

    flushRun(out, runCount);
    runCount = 0;

    const slot = hashColor565(color);
    if (index[slot] === color) {
      out.push(slot);
      prevColor = color;
      continue;
    }

    out.push(0xff, color & 0xff, (color >>> 8) & 0xff);
    index[slot] = color;
    prevColor = color;
  }

  flushRun(out, runCount);
  flushSkip(out, skipCount);

  return {
    family: "cpqoi",
    formatName: "cpqoi",
    width,
    height,
    data: new Uint8Array(out),
    pixels565,
  };
}

export function decodeCpqoiFrame(payload, previous565 = null) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length < 8 || bytes[0] !== 0x43 || bytes[1] !== 0x50 || bytes[2] !== 0x51 || bytes[3] !== 0x4f) {
    throw new Error("Invalid CPQOI payload");
  }

  const width = bytes[4] | (bytes[5] << 8);
  const height = bytes[6] | (bytes[7] << 8);
  const pixels565 = previous565 ? new Uint16Array(previous565) : new Uint16Array(width * height);
  const index = new Uint16Array(64);
  let prevColor = 0;
  let p = 8;
  let cursor = 0;

  while (p < bytes.length && cursor < pixels565.length) {
    const b1 = bytes[p++];
    if (b1 < 0x40) {
      prevColor = index[b1];
      pixels565[cursor++] = prevColor;
    } else if (b1 < 0x80) {
      cursor += (b1 & 0x3f) + 1;
    } else if (b1 < 0xc0) {
      const run = (b1 & 0x3f) + 1;
      pixels565.fill(prevColor, cursor, cursor + run);
      cursor += run;
    } else if (b1 === 0xff) {
      prevColor = bytes[p] | (bytes[p + 1] << 8);
      p += 2;
      index[hashColor565(prevColor)] = prevColor;
      pixels565[cursor++] = prevColor;
    } else if (b1 === 0xfe) {
      cursor += (bytes[p] | (bytes[p + 1] << 8)) + 1;
      p += 2;
    } else if (b1 === 0xfd) {
      const run = (bytes[p] | (bytes[p + 1] << 8)) + 1;
      p += 2;
      pixels565.fill(prevColor, cursor, cursor + run);
      cursor += run;
    } else {
      throw new Error(`Unsupported CPQOI opcode 0x${b1.toString(16)}`);
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels565.length; i += 1) {
    const [r, g, b, a] = rgb565ToRgba(pixels565[i]);
    const offset = i * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = a;
  }

  return {
    width,
    height,
    pixels565,
    data: rgba,
  };
}
