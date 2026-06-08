import { packGintPayload } from "./fxconv_cg.mjs";
import { packFxPayload, parseFxPayload } from "./fxconv_fx.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const GMPAK_ENTRY_TYPES = {
  META: 0,
  VIDEO_CPQOI: 1,
  SUBTITLE: 2,
  AUDIO: 3,
  VIDEO_GINT_IMAGE: 4,
  VIDEO_FX_IMAGE: 5,
};

export const GMPAK_ENTRY_TYPE_NAMES = {
  0: "META",
  1: "VIDEO_CPQOI",
  2: "SUBTITLE",
  3: "AUDIO",
  4: "VIDEO_GINT_IMAGE",
  5: "VIDEO_FX_IMAGE",
};

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

function decodeNullPaddedAscii(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) {
    end = bytes.length;
  }
  return textDecoder.decode(bytes.slice(0, end));
}

function encodeEntryName(name) {
  const ascii = new Uint8Array(16);
  const encoded = textEncoder.encode(name.slice(0, 16));
  ascii.set(encoded.slice(0, 16), 0);
  return ascii;
}

function buildMetaPayload({ fps, frameCount, width, height }) {
  return textEncoder.encode(
    `fps=${fps}\nframes=${frameCount}\nwidth=${width}\nheight=${height}\n`
  );
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("buildGmpak requires at least one converted frame");
  }

  const width = frames[0].width;
  const height = frames[0].height;

  frames.forEach((frame, index) => {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(`Frame ${index} does not match the first frame size ${width}x${height}`);
    }
  });

  return { frames, width, height };
}

export function buildGmpak({ frames, fps = 15 }) {
  const normalized = normalizeFrames(frames);
  const metaPayload = buildMetaPayload({
    fps,
    frameCount: normalized.frames.length,
    width: normalized.width,
    height: normalized.height,
  });

  const records = [
    {
      name: "META",
      type: 0,
      payload: metaPayload,
    },
    ...normalized.frames.map((frame, index) => ({
      name: `FRM_${index.toString().padStart(4, "0")}`,
      type: frame.family === "fx" ? GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE : GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE,
      payload: frame.family === "fx" ? packFxPayload(frame) : packGintPayload(frame),
    })),
  ];

  const headerSize = 10;
  const tocCountSize = 4;
  const tocEntrySize = 25;
  const dataSize = records.reduce((sum, record) => sum + record.payload.length, 0);
  const tocOffset = headerSize + dataSize;
  const totalSize = tocOffset + tocCountSize + (records.length * tocEntrySize);

  const file = new Uint8Array(totalSize);
  file.set(textEncoder.encode("GMPK"), 0);
  writeUint16LE(file, 4, 1);
  writeUint32LE(file, 6, tocOffset);

  const tocEntries = [];
  let offset = headerSize;
  for (const record of records) {
    file.set(record.payload, offset);
    tocEntries.push({
      name: encodeEntryName(record.name),
      type: record.type,
      offset,
      length: record.payload.length,
    });
    offset += record.payload.length;
  }

  writeUint32LE(file, tocOffset, tocEntries.length);
  let tocCursor = tocOffset + tocCountSize;
  for (const entry of tocEntries) {
    file.set(entry.name, tocCursor);
    tocCursor += 16;
    file[tocCursor] = entry.type & 0xff;
    tocCursor += 1;
    writeUint32LE(file, tocCursor, entry.offset);
    tocCursor += 4;
    writeUint32LE(file, tocCursor, entry.length);
    tocCursor += 4;
  }

  return file;
}

export function buildGmpakBlob(options) {
  return new Blob([buildGmpak(options)], { type: "application/octet-stream" });
}

export function parseGintPayload(payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length < 14) {
    throw new Error("GINT payload is too small to contain its header");
  }

  const profile = bytes[0];
  const width = readUint16LE(bytes, 1);
  const height = readUint16LE(bytes, 3);
  const stride = readUint16LE(bytes, 5);
  const colorCount = bytes[7];
  const paletteLength = readUint16LE(bytes, 8);
  const dataLength = readUint32LE(bytes, 10);
  const expectedSize = 14 + paletteLength + dataLength;

  if (bytes.length < expectedSize) {
    throw new Error(`GINT payload is truncated: expected ${expectedSize} bytes, got ${bytes.length}`);
  }

  const palette = bytes.slice(14, 14 + paletteLength);
  const data = bytes.slice(14 + paletteLength, expectedSize);

  return {
    profile,
    width,
    height,
    stride,
    colorCount,
    palette,
    data,
    totalSize: expectedSize,
  };
}

export function parseGmpak(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 14) {
    throw new Error("GMPAK file is too small");
  }

  const magic = textDecoder.decode(bytes.slice(0, 4));
  if (magic !== "GMPK") {
    throw new Error(`Invalid GMPAK magic '${magic}'`);
  }

  const version = readUint16LE(bytes, 4);
  const tocOffset = readUint32LE(bytes, 6);
  if (tocOffset + 4 > bytes.length) {
    throw new Error("GMPAK TOC offset is outside the file");
  }

  const entryCount = readUint32LE(bytes, tocOffset);
  const entries = [];
  let cursor = tocOffset + 4;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 25 > bytes.length) {
      throw new Error(`GMPAK TOC entry ${index} is truncated`);
    }

    const nameBytes = bytes.slice(cursor, cursor + 16);
    const name = decodeNullPaddedAscii(nameBytes);
    cursor += 16;
    const type = bytes[cursor];
    cursor += 1;
    const offset = readUint32LE(bytes, cursor);
    cursor += 4;
    const length = readUint32LE(bytes, cursor);
    cursor += 4;

    if (offset + length > bytes.length) {
      throw new Error(`GMPAK entry '${name}' exceeds file size`);
    }

    const payload = bytes.slice(offset, offset + length);
    const entry = {
      index,
      name,
      type,
      typeName: GMPAK_ENTRY_TYPE_NAMES[type] || `TYPE_${type}`,
      offset,
      length,
      payload,
      payloadKind: "binary",
    };

    if (type === GMPAK_ENTRY_TYPES.META) {
      entry.payloadKind = "meta";
      entry.text = textDecoder.decode(payload);
      const meta = {};
      for (const line of entry.text.split(/\r?\n/)) {
        if (!line.includes("=")) continue;
        const [key, value] = line.split("=", 2);
        meta[key] = value;
      }
      entry.meta = meta;
    } else if (type === GMPAK_ENTRY_TYPES.SUBTITLE) {
      entry.payloadKind = "subtitle";
      entry.text = textDecoder.decode(payload);
    } else if (type === GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE) {
      try {
        const fx = parseFxPayload(payload);
        entry.payloadKind = "fx";
        entry.fx = fx;
      } catch {
        // Keep as opaque binary if it doesn't parse as an FX payload.
      }
    } else if (type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE) {
      try {
        const gint = parseGintPayload(payload);
        entry.payloadKind = "gint";
        entry.gint = gint;
      } catch {
        // Keep as opaque binary if it doesn't parse as a GINT payload.
      }
    }

    entries.push(entry);
  }

  return {
    magic,
    version,
    tocOffset,
    entryCount,
    size: bytes.length,
    bytes,
    entries,
  };
}

export function rebuildGmpakFromEntries(parsed, updatedEntries = parsed.entries) {
  if (!Array.isArray(updatedEntries) || updatedEntries.length === 0) {
    throw new Error("Need at least one entry to rebuild a GMPAK");
  }

  const headerSize = 10;
  const tocCountSize = 4;
  const tocEntrySize = 25;
  const normalizedEntries = updatedEntries.map((entry, index) => {
    const payload = entry.payload instanceof Uint8Array ? entry.payload : new Uint8Array(entry.payload);
    return {
      index,
      name: entry.name,
      type: entry.type,
      payload,
    };
  });

  const dataSize = normalizedEntries.reduce((sum, entry) => sum + entry.payload.length, 0);
  const tocOffset = headerSize + dataSize;
  const totalSize = tocOffset + tocCountSize + (normalizedEntries.length * tocEntrySize);
  const file = new Uint8Array(totalSize);

  file.set(textEncoder.encode("GMPK"), 0);
  writeUint16LE(file, 4, parsed.version ?? 1);
  writeUint32LE(file, 6, tocOffset);

  let dataCursor = headerSize;
  const tocEntries = [];
  for (const entry of normalizedEntries) {
    file.set(entry.payload, dataCursor);
    tocEntries.push({
      name: encodeEntryName(entry.name),
      type: entry.type,
      offset: dataCursor,
      length: entry.payload.length,
    });
    dataCursor += entry.payload.length;
  }

  writeUint32LE(file, tocOffset, tocEntries.length);
  let tocCursor = tocOffset + tocCountSize;
  for (const entry of tocEntries) {
    file.set(entry.name, tocCursor);
    tocCursor += 16;
    file[tocCursor] = entry.type & 0xff;
    tocCursor += 1;
    writeUint32LE(file, tocCursor, entry.offset);
    tocCursor += 4;
    writeUint32LE(file, tocCursor, entry.length);
    tocCursor += 4;
  }

  return file;
}
