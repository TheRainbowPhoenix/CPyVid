import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const FFMPEG_CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

function buildResizeFilter(settings) {
  const { width, height, resizeMode } = settings;
  if (resizeMode === "crop") {
    return `crop='min(in_w,in_h)':'min(in_w,in_h)',scale=${width}:${height}`;
  }
  if (resizeMode === "pad") {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  return `scale=${width}:${height}`;
}

export function buildVideoFilter(settings) {
  const filters = [buildResizeFilter(settings)];
  if (settings.visualStyle === "grayscale") {
    filters.push("format=gray");
    filters.push("format=rgba");
  }
  filters.push(`fps=${settings.fps}`);
  return filters.join(",");
}

export async function createBrowserFFmpeg({ onLog, onProgress } = {}) {
  const ffmpeg = new FFmpeg();
  if (onLog) {
    ffmpeg.on("log", onLog);
  }
  if (onProgress) {
    ffmpeg.on("progress", onProgress);
  }

  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  return ffmpeg;
}

export async function extractRgbaFrames(ffmpeg, inputFile, settings) {
  const inputName = `input${inputFile.name.match(/\.[^.]+$/)?.[0] || ".mp4"}`;
  const outputName = "frames.rgba";
  const args = ["-y"];

  if (settings.startTime) {
    args.push("-ss", String(settings.startTime));
  }

  args.push("-i", inputName);

  if (settings.duration) {
    args.push("-t", String(settings.duration));
  }

  args.push(
    "-vf",
    buildVideoFilter(settings),
    "-an",
    "-sn",
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    outputName
  );

  await ffmpeg.writeFile(inputName, await fetchFile(inputFile));
  await ffmpeg.exec(args);
  const raw = await ffmpeg.readFile(outputName);

  const frameSize = settings.width * settings.height * 4;
  if (raw.length % frameSize !== 0) {
    throw new Error(`Raw frame buffer has unexpected size ${raw.length} for frame size ${frameSize}`);
  }

  const frameCount = raw.length / frameSize;

  return {
    rawFrames: raw,
    frameCount,
    frameSize,
    width: settings.width,
    height: settings.height,
    outputName,
    inputName,
    ffmpegArgs: args,
  };
}

export function frameViewFromRaw(rawFrames, frameIndex, width, height) {
  const frameSize = width * height * 4;
  const offset = frameIndex * frameSize;
  return {
    width,
    height,
    data: new Uint8ClampedArray(rawFrames.buffer, rawFrames.byteOffset + offset, frameSize),
  };
}
