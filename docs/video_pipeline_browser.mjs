import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const FFMPEG_CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const CLASS_WORKER_URL = new URL("./ffmpeg_wasm_worker.js", import.meta.url).href;

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

function buildBaseVideoFilters(settings) {
  const filters = [buildResizeFilter(settings)];
  if (settings.visualStyle === "grayscale") {
    filters.push("format=gray");
  }
  filters.push(`fps=${settings.fps}`);
  return filters;
}

function buildPaletteFilterComplex(settings) {
  const base = buildBaseVideoFilters(settings).join(",");
  const maxColors = Number(settings.colorCount);
  const dither = settings.dither === "Floyd-Steinberg" ? "floyd_steinberg" : "none";
  return [
    `[0:v]${base}[pre]`,
    "[pre]split[a][b]",
    `[a]palettegen=max_colors=${maxColors}:reserve_transparent=0[pal]`,
    `[b][pal]paletteuse=dither=${dither}[out]`,
  ].join(";");
}

export function buildVideoFilter(settings) {
  return buildBaseVideoFilters(settings).join(",");
}

function shouldUseFfmpegPalette(settings) {
  if (settings.colorCount === "Original") {
    return false;
  }
  const maxColors = Number(settings.colorCount);
  return Number.isFinite(maxColors) && maxColors >= 4;
}

async function safeDeleteFile(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // Ignore missing-file cleanup failures.
  }
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
    classWorkerURL: CLASS_WORKER_URL,
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.worker.js`, "text/javascript"),
  });

  return ffmpeg;
}

export async function extractRgbaFrames(ffmpeg, inputFile, settings) {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputName = `input_${runId}${inputFile.name.match(/\.[^.]+$/)?.[0] || ".mp4"}`;
  const outputName = `frames_${runId}.rgba`;
  const args = ["-y"];

  if (settings.startTime) {
    args.push("-ss", String(settings.startTime));
  }

  args.push("-i", inputName);

  if (settings.duration) {
    args.push("-t", String(settings.duration));
  }

  const useFfmpegPalette = shouldUseFfmpegPalette(settings);
  if (!useFfmpegPalette) {
    args.push("-vf", buildVideoFilter(settings));
  } else {
    args.push("-filter_complex", buildPaletteFilterComplex(settings), "-map", "[out]");
  }

  args.push("-an", "-sn", "-pix_fmt", "rgba", "-f", "rawvideo", outputName);

  let raw;
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));
    await ffmpeg.exec(args);
    raw = await ffmpeg.readFile(outputName);
  } catch (error) {
    throw new Error(error?.message || String(error));
  } finally {
    await safeDeleteFile(ffmpeg, inputName);
    await safeDeleteFile(ffmpeg, outputName);
  }

  if (!raw) {
    throw new Error("ffmpeg did not produce any frame data");
  }

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
    usedFfmpegPalette: useFfmpegPalette,
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
