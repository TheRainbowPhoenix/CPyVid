import { bytesToPythonLiteral, toHex } from "./fxconv_cg.mjs";

export const FX_BLACK = 0;
export const FX_DARK = 1;
export const FX_LIGHT = 2;
export const FX_WHITE = 3;
export const FX_ALPHA = 4;

const FX_RGBA = {
  [FX_BLACK]: [0, 0, 0, 255],
  [FX_DARK]: [85, 85, 85, 255],
  [FX_LIGHT]: [170, 170, 170, 255],
  [FX_WHITE]: [255, 255, 255, 255],
  [FX_ALPHA]: [0, 0, 0, 0],
};

export const FX_FORMATS = [
  {
    id: 0x0,
    name: "mono",
    gray: false,
    colors: new Set([FX_BLACK, FX_WHITE]),
    layers: [
      (color) => color === FX_BLACK,
    ],
  },
  {
    id: 0x1,
    name: "mono_alpha",
    gray: false,
    colors: new Set([FX_BLACK, FX_WHITE, FX_ALPHA]),
    layers: [
      (color) => color !== FX_ALPHA,
      (color) => color === FX_BLACK,
    ],
  },
  {
    id: 0x2,
    name: "gray",
    gray: true,
    colors: new Set([FX_BLACK, FX_DARK, FX_LIGHT, FX_WHITE]),
    layers: [
      (color) => color === FX_BLACK || color === FX_LIGHT,
      (color) => color === FX_BLACK || color === FX_DARK,
    ],
  },
  {
    id: 0x3,
    name: "gray_alpha",
    gray: true,
    colors: new Set([FX_BLACK, FX_DARK, FX_LIGHT, FX_WHITE, FX_ALPHA]),
    layers: [
      (color) => color !== FX_ALPHA,
      (color) => color === FX_BLACK || color === FX_LIGHT,
      (color) => color === FX_BLACK || color === FX_DARK,
    ],
  },
];

const FX_FORMAT_BY_NAME = new Map(FX_FORMATS.map((format) => [format.name, format]));
const FX_FORMAT_BY_ID = new Map(FX_FORMATS.map((format) => [format.id, format]));

function writeUint16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function readUint16LE(source, offset) {
  return source[offset] | (source[offset + 1] << 8);
}

function readUint32LE(source, offset) {
  return (
    source[offset] |
    (source[offset + 1] << 8) |
    (source[offset + 2] << 16) |
    (source[offset + 3] << 24)
  ) >>> 0;
}

function luminance(r, g, b) {
  return (r * 299) + (g * 587) + (b * 114);
}

function quantizeFxPixel(r, g, b, a) {
  if (a < 128) {
    return FX_ALPHA;
  }

  const y = luminance(r, g, b);
  if (y < 42500) return FX_BLACK;
  if (y < 127500) return FX_DARK;
  if (y < 212500) return FX_LIGHT;
  return FX_WHITE;
}

function quantizeImageDataToFxColors(imageInput) {
  const { width, height, data } = imageInput;
  const colors = new Uint8Array(width * height);
  const used = new Set();

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const color = quantizeFxPixel(data[i], data[i + 1], data[i + 2], data[i + 3]);
    colors[p] = color;
    used.add(color);
  }

  return { width, height, colors, usedColors: used };
}

function resolveFxFormat(requestedFormatName, usedColors) {
  if (!requestedFormatName || requestedFormatName === "fx:auto") {
    let name = usedColors.has(FX_DARK) || usedColors.has(FX_LIGHT) ? "gray" : "mono";
    if (usedColors.has(FX_ALPHA)) {
      name += "_alpha";
    }
    return FX_FORMAT_BY_NAME.get(name);
  }

  const format = FX_FORMAT_BY_NAME.get(requestedFormatName);
  if (!format) {
    throw new Error(`Unknown fx image format '${requestedFormatName}'`);
  }

  const allowedSourceColors = new Set(format.colors);
  if (format.name === "mono" || format.name === "mono_alpha") {
    allowedSourceColors.add(FX_DARK);
    allowedSourceColors.add(FX_LIGHT);
  }

  for (const color of usedColors) {
    if (!allowedSourceColors.has(color)) {
      throw new Error(`${requestedFormatName} has too few colors for this image`);
    }
  }

  return format;
}

function coerceColorsForFormat(colorCodes, format) {
  if (format.name !== "mono" && format.name !== "mono_alpha") {
    const usedColors = new Set();
    for (const color of colorCodes) {
      usedColors.add(color);
    }
    return { colors: colorCodes, usedColors };
  }

  const coerced = new Uint8Array(colorCodes.length);
  const usedColors = new Set();
  for (let i = 0; i < colorCodes.length; i += 1) {
    const color = colorCodes[i];
    let mapped = color;
    if (color === FX_DARK) {
      mapped = FX_BLACK;
    } else if (color === FX_LIGHT) {
      mapped = FX_WHITE;
    }
    coerced[i] = mapped;
    usedColors.add(mapped);
  }

  return { colors: coerced, usedColors };
}

export function isFxFormatName(name) {
  return name === "fx:auto" || FX_FORMAT_BY_NAME.has(name);
}

export function findFxFormat(name) {
  if (!name || name === "fx:auto") {
    return null;
  }
  return FX_FORMAT_BY_NAME.get(name) || null;
}

export function fxLayerCount(profile) {
  const format = FX_FORMAT_BY_ID.get(profile);
  if (!format) {
    throw new Error(`Unknown fx profile id ${profile}`);
  }
  return format.layers.length;
}

export function fxRowStride(width) {
  return 4 * ((width + 31) >> 5);
}

function projectLayer(colorCodes, width, height, predicate) {
  const longwordsPerRow = (width + 31) >> 5;
  const layer = new Uint8Array(4 * longwordsPerRow * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = predicate(colorCodes[(y * width) + x]) ? 1 : 0;
      if (bit) {
        layer[(4 * y * longwordsPerRow) + (x >> 3)] |= (1 << (~x & 7));
      }
    }
  }

  return layer;
}

function interleaveFxLayers(layers) {
  const layerCount = layers.length;
  const layerSize = layers[0].length;
  const data = new Uint8Array(layerCount * layerSize);
  let cursor = 0;

  for (let longword = 0; longword < layerSize / 4; longword += 1) {
    for (const layer of layers) {
      for (let i = 0; i < 4; i += 1) {
        data[cursor] = layer[(4 * longword) + i];
        cursor += 1;
      }
    }
  }

  return data;
}

function deinterleaveFxLayers(data, layerCount, longwordsPerRow, height) {
  const layerSize = 4 * longwordsPerRow * height;
  const layers = Array.from({ length: layerCount }, () => new Uint8Array(layerSize));
  let cursor = 0;

  for (let longword = 0; longword < layerSize / 4; longword += 1) {
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
      for (let i = 0; i < 4; i += 1) {
        layers[layerIndex][(4 * longword) + i] = data[cursor];
        cursor += 1;
      }
    }
  }

  return layers;
}

function readLayerBit(layer, width, x, y) {
  const longwordsPerRow = (width + 31) >> 5;
  const offset = (4 * y * longwordsPerRow) + (x >> 3);
  return (layer[offset] >> (~x & 7)) & 1;
}

function decodeFxPixel(format, layers, width, x, y) {
  if (format.name === "mono") {
    return readLayerBit(layers[0], width, x, y) ? FX_BLACK : FX_WHITE;
  }

  if (format.name === "mono_alpha") {
    if (!readLayerBit(layers[0], width, x, y)) return FX_ALPHA;
    return readLayerBit(layers[1], width, x, y) ? FX_BLACK : FX_WHITE;
  }

  if (format.name === "gray") {
    const lightPlane = readLayerBit(layers[0], width, x, y);
    const darkPlane = readLayerBit(layers[1], width, x, y);
    if (lightPlane && darkPlane) return FX_BLACK;
    if (lightPlane) return FX_LIGHT;
    if (darkPlane) return FX_DARK;
    return FX_WHITE;
  }

  if (!readLayerBit(layers[0], width, x, y)) return FX_ALPHA;
  const lightPlane = readLayerBit(layers[1], width, x, y);
  const darkPlane = readLayerBit(layers[2], width, x, y);
  if (lightPlane && darkPlane) return FX_BLACK;
  if (lightPlane) return FX_LIGHT;
  if (darkPlane) return FX_DARK;
  return FX_WHITE;
}

export function convertImageDataToFx(imageInput, requestedFormatName = "fx:auto") {
  const quantized = quantizeImageDataToFxColors(imageInput);
  const format = resolveFxFormat(requestedFormatName, quantized.usedColors);
  const coerced = coerceColorsForFormat(quantized.colors, format);
  const layers = format.layers.map((predicate) =>
    projectLayer(coerced.colors, quantized.width, quantized.height, predicate)
  );

  return {
    family: "fx",
    profile: format.id,
    formatName: format.name,
    width: quantized.width,
    height: quantized.height,
    data: interleaveFxLayers(layers),
    layerCount: layers.length,
    usesGray: format.gray,
    hasAlpha: format.name.endsWith("_alpha"),
    colorCount: coerced.usedColors.size,
  };
}

export function packFxPayload(image) {
  if (!(image.data instanceof Uint8Array)) {
    throw new TypeError("image.data must be a Uint8Array");
  }

  const payload = new Uint8Array(9 + image.data.length);
  payload[0] = image.profile & 0xff;
  writeUint16LE(payload, 1, image.width);
  writeUint16LE(payload, 3, image.height);
  writeUint32LE(payload, 5, image.data.length);
  payload.set(image.data, 9);
  return payload;
}

export function parseFxPayload(payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length < 9) {
    throw new Error("FX payload is too small to contain its header");
  }

  const profile = bytes[0];
  const width = readUint16LE(bytes, 1);
  const height = readUint16LE(bytes, 3);
  const dataLength = readUint32LE(bytes, 5);
  const expectedSize = 9 + dataLength;
  if (bytes.length < expectedSize) {
    throw new Error(`FX payload is truncated: expected ${expectedSize} bytes, got ${bytes.length}`);
  }

  const format = FX_FORMAT_BY_ID.get(profile);
  if (!format) {
    throw new Error(`Unknown fx profile id ${profile}`);
  }

  return {
    family: "fx",
    profile,
    formatName: format.name,
    width,
    height,
    data: bytes.slice(9, expectedSize),
    dataLength,
    layerCount: format.layers.length,
    usesGray: format.gray,
    hasAlpha: format.name.endsWith("_alpha"),
    colorCount: format.colors.size,
  };
}

export function decodeFxImage(image) {
  const format = FX_FORMAT_BY_ID.get(image.profile);
  if (!format) {
    throw new Error(`Unknown fx profile id ${image.profile}`);
  }

  const longwordsPerRow = (image.width + 31) >> 5;
  const layers = deinterleaveFxLayers(image.data, format.layers.length, longwordsPerRow, image.height);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const color = decodeFxPixel(format, layers, image.width, x, y);
      const offset = ((y * image.width) + x) * 4;
      const [r, g, b, a] = FX_RGBA[color];
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }

  return {
    width: image.width,
    height: image.height,
    data: rgba,
  };
}

export function toFxImagePy(image, name = "image") {
  return [
    "import gint",
    `${name} = gint.image(${image.profile}, ${image.width}, ${image.height}, ${bytesToPythonLiteral(image.data)})`,
    "",
  ].join("\n");
}

export function toFxImageHexJson(image) {
  return {
    family: "fx",
    profile: image.profile,
    format_name: image.formatName,
    width: image.width,
    height: image.height,
    layer_count: image.layerCount,
    color_count: image.colorCount,
    data_hex: toHex(image.data),
  };
}
