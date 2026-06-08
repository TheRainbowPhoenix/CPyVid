const DEFAULT_HEXDUMP_WIDTH = 16;

export const IMAGE_RGB16 = 0;
export const IMAGE_P8 = 1;
export const IMAGE_P4 = 2;

export const CG_FORMATS = [
  { id: 0x0, depth: IMAGE_RGB16, names: ["rgb565", "r5g6b5"], hasAlpha: false, alpha: null, isIndexed: false },
  { id: 0x1, depth: IMAGE_RGB16, names: ["rgb565a", "r5g6b5a"], hasAlpha: true, alpha: 0x0001, isIndexed: false },
  { id: 0x4, depth: IMAGE_P8, names: ["p8_rgb565"], hasAlpha: false, alpha: null, isIndexed: true, paletteBase: 0x80, colorCount: 256, trimPalette: true },
  { id: 0x5, depth: IMAGE_P8, names: ["p8_rgb565a"], hasAlpha: true, alpha: 0x80, isIndexed: true, paletteBase: 0x81, colorCount: 256, trimPalette: true },
  { id: 0x6, depth: IMAGE_P4, names: ["p4_rgb565"], hasAlpha: false, alpha: null, isIndexed: true, paletteBase: 0x00, colorCount: 16, trimPalette: false },
  { id: 0x3, depth: IMAGE_P4, names: ["p4_rgb565a"], hasAlpha: true, alpha: 0x00, isIndexed: true, paletteBase: 0x01, colorCount: 16, trimPalette: false },
];

const FORMAT_BY_NAME = new Map();
for (const format of CG_FORMATS) {
  for (const name of format.names) {
    FORMAT_BY_NAME.set(name, format);
  }
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(source, index) {
  while (index < source.length && isWhitespace(source[index])) {
    index += 1;
  }
  return index;
}

function parseIntegerToken(source, index) {
  index = skipWhitespace(source, index);
  const match = /^[+-]?\d+/.exec(source.slice(index));
  if (!match) {
    throw new Error(`Expected integer at offset ${index}`);
  }
  return {
    value: Number.parseInt(match[0], 10),
    nextIndex: index + match[0].length,
  };
}

function parseIdentifierToken(source, index) {
  index = skipWhitespace(source, index);
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
  if (!match) {
    throw new Error(`Expected identifier at offset ${index}`);
  }
  return {
    value: match[0],
    nextIndex: index + match[0].length,
  };
}

function expectCommaOrEnd(source, index) {
  index = skipWhitespace(source, index);
  const char = source[index];
  if (char === ",") {
    return { kind: "comma", nextIndex: index + 1 };
  }
  if (char === ")") {
    return { kind: "end", nextIndex: index };
  }
  throw new Error(`Expected ',' or ')' at offset ${index}`);
}

function parsePythonBytesLiteral(source, index) {
  index = skipWhitespace(source, index);
  const prefix = source[index];
  if (prefix !== "b" && prefix !== "B") {
    throw new Error(`Expected Python bytes literal at offset ${index}`);
  }

  const quote = source[index + 1];
  if (quote !== "'" && quote !== "\"") {
    throw new Error(`Expected Python bytes quote at offset ${index + 1}`);
  }

  const bytes = [];
  let cursor = index + 2;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === quote) {
      return {
        value: new Uint8Array(bytes),
        nextIndex: cursor + 1,
      };
    }

    if (char !== "\\") {
      const codePoint = char.codePointAt(0);
      if (codePoint > 0xff) {
        throw new Error(`Byte literal contains non-byte code point at offset ${cursor}`);
      }
      bytes.push(codePoint);
      cursor += char.length;
      continue;
    }

    cursor += 1;
    if (cursor >= source.length) {
      throw new Error("Unterminated escape sequence in Python bytes literal");
    }

    const escaped = source[cursor];
    switch (escaped) {
      case "\\":
        bytes.push(0x5c);
        cursor += 1;
        break;
      case "'":
        bytes.push(0x27);
        cursor += 1;
        break;
      case "\"":
        bytes.push(0x22);
        cursor += 1;
        break;
      case "n":
        bytes.push(0x0a);
        cursor += 1;
        break;
      case "r":
        bytes.push(0x0d);
        cursor += 1;
        break;
      case "t":
        bytes.push(0x09);
        cursor += 1;
        break;
      case "x": {
        const hex = source.slice(cursor + 1, cursor + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new Error(`Invalid \\x escape at offset ${cursor - 1}`);
        }
        bytes.push(Number.parseInt(hex, 16));
        cursor += 3;
        break;
      }
      default: {
        const octalMatch = /^[0-7]{1,3}/.exec(source.slice(cursor));
        if (!octalMatch) {
          throw new Error(`Unsupported escape \\${escaped} at offset ${cursor - 1}`);
        }
        bytes.push(Number.parseInt(octalMatch[0], 8));
        cursor += octalMatch[0].length;
        break;
      }
    }
  }

  throw new Error("Unterminated Python bytes literal");
}

function parseNoneOrBytes(source, index) {
  index = skipWhitespace(source, index);
  if (source.startsWith("None", index)) {
    return {
      value: new Uint8Array(0),
      nextIndex: index + 4,
    };
  }
  return parsePythonBytesLiteral(source, index);
}

function writeUint16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint16BE(target, offset, value) {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeUint32LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function byteToHex(byte) {
  return byte.toString(16).padStart(2, "0");
}

function clamp8(value) {
  return Math.max(0, Math.min(255, value));
}

function makeColorInt(r, g, b) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function splitColorInt(color) {
  return {
    r: (color >>> 16) & 0xff,
    g: (color >>> 8) & 0xff,
    b: color & 0xff,
  };
}

function luminanceOfColor(color) {
  const { r, g, b } = splitColorInt(color);
  return (r * 299) + (g * 587) + (b * 114);
}

function rgb24To16(r, g, b) {
  const r5 = (r & 0xff) >>> 3;
  const g6 = (g & 0xff) >>> 2;
  const b5 = (b & 0xff) >>> 3;
  return (r5 << 11) | (g6 << 5) | b5;
}

function rgb565ToRgba(color16) {
  const r5 = (color16 >>> 11) & 0x1f;
  const g6 = (color16 >>> 5) & 0x3f;
  const b5 = color16 & 0x1f;
  const r = Math.round((r5 * 255) / 31);
  const g = Math.round((g6 * 255) / 63);
  const b = Math.round((b5 * 255) / 31);
  return [r, g, b, 255];
}

function thresholdAlpha(alpha) {
  return alpha >= 128 ? 255 : 0;
}

function buildHistogram(rgbData) {
  const histogram = new Map();
  const order = [];

  for (let i = 0; i < rgbData.length; i += 3) {
    const color = makeColorInt(rgbData[i], rgbData[i + 1], rgbData[i + 2]);
    const current = histogram.get(color);
    if (current === undefined) {
      histogram.set(color, 1);
      order.push(color);
    } else {
      histogram.set(color, current + 1);
    }
  }

  return { histogram, order };
}

function dominantChannel(colors) {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;

  for (const color of colors) {
    const { r, g, b } = splitColorInt(color.value);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }

  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;

  if (rangeR >= rangeG && rangeR >= rangeB) return { channel: "r", range: rangeR };
  if (rangeG >= rangeR && rangeG >= rangeB) return { channel: "g", range: rangeG };
  return { channel: "b", range: rangeB };
}

function sortColorsByChannel(colors, channel) {
  return [...colors].sort((a, b) => {
    const colorA = splitColorInt(a.value);
    const colorB = splitColorInt(b.value);
    if (colorA[channel] !== colorB[channel]) {
      return colorA[channel] - colorB[channel];
    }
    return luminanceOfColor(a.value) - luminanceOfColor(b.value);
  });
}

function makeBox(colors) {
  const { range } = dominantChannel(colors);
  let population = 0;
  for (const color of colors) {
    population += color.count;
  }
  return { colors, population, range, score: population * Math.max(range, 1) };
}

function splitBox(box) {
  if (box.colors.length <= 1) {
    return null;
  }

  const { channel } = dominantChannel(box.colors);
  const sorted = sortColorsByChannel(box.colors, channel);
  const total = sorted.reduce((sum, color) => sum + color.count, 0);
  let running = 0;
  let splitIndex = -1;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    running += sorted[i].count;
    if (running >= total / 2) {
      splitIndex = i + 1;
      break;
    }
  }

  if (splitIndex <= 0 || splitIndex >= sorted.length) {
    splitIndex = Math.floor(sorted.length / 2);
  }
  if (splitIndex <= 0 || splitIndex >= sorted.length) {
    return null;
  }

  return [
    makeBox(sorted.slice(0, splitIndex)),
    makeBox(sorted.slice(splitIndex)),
  ];
}

function averageBoxColor(box) {
  let total = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (const color of box.colors) {
    const { r, g, b } = splitColorInt(color.value);
    total += color.count;
    sumR += r * color.count;
    sumG += g * color.count;
    sumB += b * color.count;
  }

  if (total === 0) {
    return makeColorInt(0, 0, 0);
  }

  return makeColorInt(
    clamp8(Math.round(sumR / total)),
    clamp8(Math.round(sumG / total)),
    clamp8(Math.round(sumB / total))
  );
}

function sortPaletteEntries(entries) {
  return [...entries].sort((a, b) => {
    if (b.population !== a.population) {
      return b.population - a.population;
    }
    return luminanceOfColor(b.color) - luminanceOfColor(a.color);
  });
}

function quantizeAdaptive(rgbData, maxColors) {
  const { histogram, order } = buildHistogram(rgbData);
  const colors = order.map((value) => ({ value, count: histogram.get(value) }));

  if (colors.length === 0) {
    return {
      palette: [],
      colorToIndex: new Map(),
    };
  }

  if (colors.length <= maxColors) {
    const entries = sortPaletteEntries(colors.map((color) => ({
      color: color.value,
      population: color.count,
      colors: [color],
    })));
    const palette = entries.map((entry) => entry.color);
    const colorToIndex = new Map();
    entries.forEach((entry, index) => {
      colorToIndex.set(entry.colors[0].value, index);
    });
    return { palette, colorToIndex };
  }

  const boxes = [makeBox(colors)];

  while (boxes.length < maxColors) {
    let bestIndex = -1;
    let bestScore = -1;

    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.colors.length <= 1) {
        continue;
      }
      if (box.score > bestScore) {
        bestScore = box.score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const split = splitBox(boxes[bestIndex]);
    if (!split) {
      break;
    }

    boxes.splice(bestIndex, 1, split[0], split[1]);
  }

  const entries = sortPaletteEntries(boxes.map((box) => ({
    color: averageBoxColor(box),
    population: box.population,
    colors: box.colors,
  })));

  const palette = entries.map((entry) => entry.color);
  const colorToIndex = new Map();

  entries.forEach((entry, paletteIndex) => {
    for (const color of entry.colors) {
      colorToIndex.set(color.value, paletteIndex);
    }
  });

  return { palette, colorToIndex };
}

function resolveFormatName(requestedName, hasAlpha) {
  if (requestedName === "" || requestedName === undefined || requestedName === null) {
    return hasAlpha ? "rgb565a" : "rgb565";
  }
  if (requestedName === "p8") {
    return hasAlpha ? "p8_rgb565a" : "p8_rgb565";
  }
  if (requestedName === "p4") {
    return hasAlpha ? "p4_rgb565a" : "p4_rgb565";
  }
  return requestedName;
}

export function findCgFormat(name) {
  return FORMAT_BY_NAME.get(name) || null;
}

export function detectImageAlpha(imageData) {
  const data = imageData.data || imageData;
  for (let i = 3; i < data.length; i += 4) {
    if (thresholdAlpha(data[i]) === 0) {
      return true;
    }
  }
  return false;
}

function normalizeImageInput(imageInput) {
  if (!imageInput || typeof imageInput.width !== "number" || typeof imageInput.height !== "number" || !imageInput.data) {
    throw new TypeError("Expected { width, height, data } image input");
  }
  const { width, height } = imageInput;
  const data = imageInput.data;
  if (data.length !== width * height * 4) {
    throw new Error(`RGBA data length ${data.length} does not match ${width}x${height}`);
  }
  return {
    width,
    height,
    data: data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data),
  };
}

function prepareRgbAndAlpha(imageInput) {
  const { width, height, data } = normalizeImageInput(imageInput);
  const opaqueMask = new Uint8Array(width * height);
  const rgbData = new Uint8Array(width * height * 3);
  let hasOpaque = false;
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const alpha = thresholdAlpha(data[i + 3]);
    opaqueMask[p] = alpha;
    if (alpha > 0 && !hasOpaque) {
      bgR = data[i];
      bgG = data[i + 1];
      bgB = data[i + 2];
      hasOpaque = true;
    }
    rgbData[p * 3] = data[i];
    rgbData[p * 3 + 1] = data[i + 1];
    rgbData[p * 3 + 2] = data[i + 2];
  }

  if (!hasOpaque) {
    bgR = 0;
    bgG = 0;
    bgB = 0;
  }

  for (let p = 0; p < width * height; p += 1) {
    if (opaqueMask[p] === 0) {
      rgbData[p * 3] = bgR;
      rgbData[p * 3 + 1] = bgG;
      rgbData[p * 3 + 2] = bgB;
    }
  }

  return { width, height, opaqueMask, rgbData };
}

function encodeIndexedImage(width, height, rgbData, opaqueMask, format) {
  const opaquePaletteCapacity = format.colorCount - Number(format.hasAlpha);
  const quantized = quantizeAdaptive(rgbData, opaquePaletteCapacity);
  const encodedPaletteColors = format.hasAlpha
    ? [makeColorInt(255, 0, 255), ...quantized.palette]
    : [...quantized.palette];

  const usedPaletteEntryCount = encodedPaletteColors.length;
  const packedColorCount = format.trimPalette ? usedPaletteEntryCount : format.colorCount;

  let stride;
  let size;
  if (format.depth === IMAGE_P8) {
    stride = width;
    size = width * height;
  } else {
    stride = (width + 1) >> 1;
    size = stride * height;
  }

  const data = new Uint8Array(size);
  const paletteMap = Array.from(
    { length: usedPaletteEntryCount },
    (_, index) => (format.paletteBase + index) % format.colorCount
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      let encodedValue;

      if (opaqueMask[pixelIndex] === 0) {
        encodedValue = format.alpha;
      } else {
        const colorKey = makeColorInt(
          rgbData[pixelIndex * 3],
          rgbData[pixelIndex * 3 + 1],
          rgbData[pixelIndex * 3 + 2]
        );
        const quantizedIndex = quantized.colorToIndex.get(colorKey);
        if (quantizedIndex === undefined) {
          throw new Error("Quantizer could not map an opaque pixel to a palette index");
        }
        encodedValue = paletteMap[quantizedIndex];
      }

      if (format.depth === IMAGE_P8) {
        data[(stride * y) + x] = encodedValue;
      } else {
        const offset = (stride * y) + (x >> 1);
        if ((x & 1) === 0) {
          data[offset] |= (encodedValue & 0x0f) << 4;
        } else {
          data[offset] |= encodedValue & 0x0f;
        }
      }
    }
  }

  const paletteLength = 2 * packedColorCount;
  const palette = new Uint8Array(paletteLength);
  for (let i = 0; i < encodedPaletteColors.length; i += 1) {
    const { r, g, b } = splitColorInt(encodedPaletteColors[i]);
    writeUint16BE(palette, i * 2, rgb24To16(r, g, b));
  }

  return {
    data,
    stride,
    palette,
    colorCount: packedColorCount,
  };
}

function encodeRgb16Image(width, height, rgbData, opaqueMask, format) {
  const stride = Math.floor((width + 1) / 2) * 4;
  const data = new Uint8Array(stride * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const r = rgbData[pixelIndex * 3];
      const g = rgbData[pixelIndex * 3 + 1];
      const b = rgbData[pixelIndex * 3 + 2];
      let color16 = rgb24To16(r, g, b);

      if (format.hasAlpha) {
        if (opaqueMask[pixelIndex] === 0) {
          color16 = format.alpha;
        } else if (color16 === format.alpha) {
          color16 ^= 1;
        }
      }

      writeUint16BE(data, (stride * y) + (x * 2), color16);
    }
  }

  return {
    data,
    stride,
    palette: new Uint8Array(0),
    colorCount: -1,
  };
}

export function convertImageDataToCg(imageInput, requestedFormatName = "") {
  const normalized = normalizeImageInput(imageInput);
  const hasAlpha = detectImageAlpha(normalized.data);
  const resolvedName = resolveFormatName(requestedFormatName, hasAlpha);
  const format = findCgFormat(resolvedName);

  if (!format) {
    throw new Error(`Unknown image format '${resolvedName}'`);
  }
  if (hasAlpha && !format.hasAlpha) {
    throw new Error(`Image has transparency, which ${resolvedName} doesn't support`);
  }

  const { width, height, opaqueMask, rgbData } = prepareRgbAndAlpha(normalized);
  const encoded = format.isIndexed
    ? encodeIndexedImage(width, height, rgbData, opaqueMask, format)
    : encodeRgb16Image(width, height, rgbData, opaqueMask, format);

  return {
    profile: format.id,
    formatName: resolvedName,
    width,
    height,
    stride: encoded.stride,
    colorCount: encoded.colorCount,
    data: encoded.data,
    palette: encoded.palette,
  };
}

export function decodeCgImage(image) {
  const format = CG_FORMATS.find((item) => item.id === image.profile);
  if (!format) {
    throw new Error(`Unknown CG profile id ${image.profile}`);
  }

  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  const paletteEntries = [];
  for (let i = 0; i + 1 < image.palette.length; i += 2) {
    paletteEntries.push((image.palette[i] << 8) | image.palette[i + 1]);
  }

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const outOffset = ((y * image.width) + x) * 4;

      if (format.depth === IMAGE_RGB16) {
        const offset = (image.stride * y) + (x * 2);
        const value = (image.data[offset] << 8) | image.data[offset + 1];
        if (format.hasAlpha && value === format.alpha) {
          rgba[outOffset + 3] = 0;
        } else {
          const [r, g, b, a] = rgb565ToRgba(value);
          rgba[outOffset] = r;
          rgba[outOffset + 1] = g;
          rgba[outOffset + 2] = b;
          rgba[outOffset + 3] = a;
        }
        continue;
      }

      let code;
      if (format.depth === IMAGE_P8) {
        code = image.data[(image.stride * y) + x];
      } else {
        const offset = (image.stride * y) + (x >> 1);
        code = ((x & 1) === 0) ? (image.data[offset] >>> 4) & 0x0f : image.data[offset] & 0x0f;
      }

      if (format.hasAlpha && code === format.alpha) {
        rgba[outOffset + 3] = 0;
        continue;
      }

      const paletteIndex = format.hasAlpha
        ? (((code - format.paletteBase + format.colorCount) % format.colorCount) + 1)
        : ((code - format.paletteBase + format.colorCount) % format.colorCount);

      const color16 = paletteEntries[paletteIndex] ?? 0;
      const [r, g, b, a] = rgb565ToRgba(color16);
      rgba[outOffset] = r;
      rgba[outOffset + 1] = g;
      rgba[outOffset + 2] = b;
      rgba[outOffset + 3] = a;
    }
  }

  return {
    width: image.width,
    height: image.height,
    data: rgba,
  };
}

export function parseFxconvPy(source) {
  const callIndex = source.indexOf("gint.image(");
  if (callIndex === -1) {
    throw new Error("Could not find a gint.image(...) call");
  }

  let index = callIndex + "gint.image(".length;
  const args = [];

  while (true) {
    index = skipWhitespace(source, index);
    if (source[index] === ")") {
      index += 1;
      break;
    }

    const current = source[index];
    let parsed;

    if (current === "b" || current === "B") {
      parsed = parsePythonBytesLiteral(source, index);
    } else if (current === "N") {
      parsed = parseNoneOrBytes(source, index);
    } else if (/[0-9+-]/.test(current)) {
      parsed = parseIntegerToken(source, index);
    } else if (/[A-Za-z_]/.test(current)) {
      const identifier = parseIdentifierToken(source, index);
      if (identifier.value !== "None") {
        throw new Error(`Unsupported token '${identifier.value}' in gint.image(...)`);
      }
      parsed = {
        value: new Uint8Array(0),
        nextIndex: identifier.nextIndex,
      };
    } else {
      throw new Error(`Unexpected token '${current}' at offset ${index}`);
    }

    args.push(parsed.value);
    index = parsed.nextIndex;

    const separator = expectCommaOrEnd(source, index);
    index = separator.nextIndex;
    if (separator.kind === "end") {
      if (source[index] !== ")") {
        throw new Error(`Expected ')' at offset ${index}`);
      }
      index += 1;
      break;
    }
  }

  if (args.length !== 7) {
    throw new Error(`Expected 7 gint.image(...) arguments for fx-CG output, got ${args.length}`);
  }

  const [profile, colorCount, width, height, stride, data, palette] = args;
  if (![profile, colorCount, width, height, stride].every(Number.isInteger)) {
    throw new Error("The first five gint.image(...) arguments must be integers");
  }
  if (!(data instanceof Uint8Array) || !(palette instanceof Uint8Array)) {
    throw new Error("The data and palette gint.image(...) arguments must be bytes literals or None");
  }

  return {
    profile,
    colorCount,
    width,
    height,
    stride,
    data,
    palette,
  };
}

export function packGintPayload(image) {
  const {
    profile,
    width,
    height,
    stride,
    colorCount,
    palette = new Uint8Array(0),
    data,
  } = image;

  if (!(data instanceof Uint8Array)) {
    throw new TypeError("image.data must be a Uint8Array");
  }
  if (!(palette instanceof Uint8Array)) {
    throw new TypeError("image.palette must be a Uint8Array");
  }

  const header = new Uint8Array(14);
  header[0] = profile & 0xff;
  writeUint16LE(header, 1, width);
  writeUint16LE(header, 3, height);
  writeUint16LE(header, 5, stride);
  header[7] = colorCount & 0xff;
  writeUint16LE(header, 8, palette.length);
  writeUint32LE(header, 10, data.length);

  const payload = new Uint8Array(header.length + palette.length + data.length);
  payload.set(header, 0);
  payload.set(palette, header.length);
  payload.set(data, header.length + palette.length);
  return payload;
}

export function toHex(bytes) {
  return Array.from(bytes, byteToHex).join("");
}

export function toHexDump(bytes, width = DEFAULT_HEXDUMP_WIDTH) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const chunk = bytes.slice(offset, offset + width);
    const hex = Array.from(chunk, byteToHex).join(" ");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}`);
  }
  return lines.join("\n");
}

export function bytesToPythonLiteral(bytes) {
  let out = "b'";
  for (const byte of bytes) {
    if (byte === 0x5c) {
      out += "\\\\";
    } else if (byte === 0x27) {
      out += "\\'";
    } else if (byte === 0x0a) {
      out += "\\n";
    } else if (byte === 0x0d) {
      out += "\\r";
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byteToHex(byte)}`;
    }
  }
  out += "'";
  return out;
}

export function toFxconvPy(image, name = "image") {
  const paletteLiteral = image.palette.length === 0 ? "None" : bytesToPythonLiteral(image.palette);
  return [
    "import gint",
    `${name} = gint.image(${image.profile}, ${image.colorCount}, ${image.width}, ${image.height}, ${image.stride}, ${bytesToPythonLiteral(image.data)}, ${paletteLiteral})`,
    "",
  ].join("\n");
}

export function toHexJson(image) {
  return {
    profile: image.profile,
    color_count: image.colorCount,
    width: image.width,
    height: image.height,
    stride: image.stride,
    data_hex: toHex(image.data),
    palette_hex: toHex(image.palette),
  };
}
