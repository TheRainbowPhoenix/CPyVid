import { packGintPayload } from "./fxconv_cg.mjs";

const textEncoder = new TextEncoder();

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
      type: 4,
      payload: packGintPayload(frame),
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
