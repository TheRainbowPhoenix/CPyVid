import { buildGmpakBlob } from "./gmpak_browser.mjs";
import { convertImageDataToCg, decodeCgImage, reduceImageDataColors, toHexJson } from "./fxconv_cg.mjs";
import { decodeCpqoiFrame, encodeCpqoiFrame } from "./cpqoi_browser.mjs";
import { createBrowserFFmpeg, extractRgbaFrames, frameViewFromRaw } from "./video_pipeline_browser.mjs";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const outputNameInput = document.getElementById("outputName");
const formatSelect = document.getElementById("formatSelect");
const fpsInput = document.getElementById("fpsInput");
const widthInput = document.getElementById("widthInput");
const heightInput = document.getElementById("heightInput");
const resizeModeSelect = document.getElementById("resizeMode");
const visualStyleSelect = document.getElementById("visualStyle");
const colorCountSelect = document.getElementById("colorCount");
const ditherSelect = document.getElementById("ditherSelect");
const startTimeInput = document.getElementById("startTime");
const durationInput = document.getElementById("duration");
const buildButton = document.getElementById("buildBtn");
const downloadButton = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const meterFill = document.getElementById("meterFill");
const factsEl = document.getElementById("facts");
const videoPreview = document.getElementById("videoPreview");
const framePreview = document.getElementById("framePreview");
const manifestEl = document.getElementById("manifest");

const state = {
  ffmpeg: null,
  inputFile: null,
  downloadBlob: null,
  manifest: null,
};

function setStatus(message, isError = false) {
  console.log(message);
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setProgress(value) {
  meterFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function sanitizeName(name) {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "VIDEO";
}

function currentSettings() {
  return {
    width: Math.max(1, Math.min(528, Number.parseInt(widthInput.value, 10) || 320)),
    height: Math.max(1, Math.min(528, Number.parseInt(heightInput.value, 10) || 528)),
    fps: Math.max(1, Math.min(20, Number.parseInt(fpsInput.value, 10) || 2)),
    resizeMode: resizeModeSelect.value,
    visualStyle: visualStyleSelect.value,
    colorCount: colorCountSelect.value,
    dither: ditherSelect.value,
    startTime: Math.max(0, Number.parseFloat(startTimeInput.value) || 0),
    duration: Math.max(0, Number.parseFloat(durationInput.value) || 0),
    formatName: formatSelect.value,
    outputName: sanitizeName(outputNameInput.value.trim()),
  };
}

function ditherModeValue(setting) {
  return setting === "Floyd-Steinberg" ? "floyd_steinberg" : "none";
}

function isCpqoiFormat(formatName) {
  return formatName === "cpqoi";
}

function updateFacts(entries = []) {
  factsEl.innerHTML = entries
    .map(([label, value]) => `<div class="fact"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function clearFramePreview() {
  const context = framePreview.getContext("2d");
  framePreview.width = 1;
  framePreview.height = 1;
  context.clearRect(0, 0, 1, 1);
}

function renderImageDataToCanvas(canvas, imageDataLike) {
  const context = canvas.getContext("2d");
  const imageData = new ImageData(imageDataLike.data, imageDataLike.width, imageDataLike.height);
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  context.putImageData(imageData, 0, 0);
}

function resetOutput() {
  if (state.downloadBlob) {
    URL.revokeObjectURL(state.downloadBlob);
    state.downloadBlob = null;
  }
  state.manifest = null;
  downloadButton.disabled = true;
  manifestEl.value = "";
  clearFramePreview();
}

async function ensureFfmpegLoaded() {
  if (state.ffmpeg) {
    return state.ffmpeg;
  }

  setStatus("Loading ffmpeg.wasm core (~31 MB)...");
  setProgress(2);

  state.ffmpeg = await createBrowserFFmpeg({
    onLog: ({ message }) => {
      if (message) {
        setStatus(message);
      }
    },
    onProgress: ({ progress }) => {
      setProgress(progress * 40);
    },
  });

  setProgress(100);
  setStatus("ffmpeg.wasm core loaded.");
  buildButton.disabled = !state.inputFile;
  return state.ffmpeg;
}

async function handleFile(file) {
  state.inputFile = file;
  resetOutput();
  videoPreview.src = URL.createObjectURL(file);
  buildButton.disabled = !state.ffmpeg;

  await new Promise((resolve) => {
    videoPreview.onloadedmetadata = () => resolve();
  });

  updateFacts([
    ["Input", file.name],
    ["Original Size", `${videoPreview.videoWidth} x ${videoPreview.videoHeight}`],
    ["Duration", `${videoPreview.duration.toFixed(2)} s`],
  ]);
  setStatus("Video loaded. Adjust settings, then build the GMPAK.");
}

async function buildGmpakFromVideo() {
  if (!state.inputFile) {
    return;
  }

  resetOutput();
  buildButton.disabled = true;
  downloadButton.disabled = true;

  try {
    const ffmpeg = await ensureFfmpegLoaded();
    const settings = currentSettings();

    setStatus("Extracting trimmed and scaled RGBA frames with ffmpeg.wasm...");
    setProgress(4);

    const extraction = await extractRgbaFrames(ffmpeg, state.inputFile, settings);
    const frames = [];
    const jsColorReductionCount = settings.colorCount === "Original" ? null : Number(settings.colorCount);
    const useJsColorReduction = jsColorReductionCount !== null
      && Number.isFinite(jsColorReductionCount)
      && jsColorReductionCount >= 1
      && jsColorReductionCount <= 3;
    const useCpqoi = isCpqoiFormat(settings.formatName);
    let previousCpqoi565 = null;
    for (let index = 0; index < extraction.frameCount; index += 1) {
      let view = frameViewFromRaw(extraction.rawFrames, index, extraction.width, extraction.height);
      if (useJsColorReduction) {
        view = reduceImageDataColors(view, jsColorReductionCount, ditherModeValue(settings.dither));
      }

      const converted = useCpqoi
        ? encodeCpqoiFrame(view, previousCpqoi565)
        : convertImageDataToCg(view, settings.formatName);
      frames.push(converted);
      if (useCpqoi) {
        previousCpqoi565 = converted.pixels565;
      }

      if (index === 0) {
        renderImageDataToCanvas(framePreview, useCpqoi ? decodeCpqoiFrame(converted.data) : decodeCgImage(converted));
      }

      const progress = 40 + ((index + 1) / extraction.frameCount) * 45;
      setProgress(progress);
      setStatus(`Converted frame ${index + 1}/${extraction.frameCount} with ${converted.formatName}...`);
    }

    setStatus("Packing GMPAK...");
    setProgress(92);

    const blob = buildGmpakBlob({ frames, fps: settings.fps });
    state.downloadBlob = URL.createObjectURL(blob);

    const firstFrameMeta = useCpqoi
      ? { bytes: frames[0].data.length, width: frames[0].width, height: frames[0].height }
      : toHexJson(frames[0]);
    state.manifest = {
      output_name: `${settings.outputName}.gmpak`,
      fps: settings.fps,
      frames: frames.length,
      width: extraction.width,
      height: extraction.height,
      format: frames[0].formatName,
      entry_type: useCpqoi ? "VIDEO_CPQOI" : "VIDEO_GINT_IMAGE",
      profile: useCpqoi ? null : firstFrameMeta.profile,
      first_frame_color_count: useCpqoi ? null : firstFrameMeta.color_count,
      first_frame_stride: useCpqoi ? null : firstFrameMeta.stride,
      first_frame_bytes: useCpqoi ? firstFrameMeta.bytes : null,
      gmpak_bytes: blob.size,
      pre_fx_color_count: settings.colorCount,
      pre_fx_dither: settings.dither,
      pre_fx_reduction_stage: extraction.usedFfmpegPalette ? "ffmpeg_palette" : (useJsColorReduction ? "js_quantizer" : "none"),
      visual_style: settings.visualStyle,
      ffmpeg_args: extraction.ffmpegArgs,
    };

    manifestEl.value = JSON.stringify(state.manifest, null, 2);
    updateFacts([
      ["Output", `${settings.outputName}.gmpak`],
      ["Frames", String(frames.length)],
      ["Frame Size", `${extraction.width} x ${extraction.height}`],
      ["Format", frames[0].formatName],
      ["Pre-FX Colors", String(settings.colorCount)],
      ["GMPAK Size", `${blob.size.toLocaleString()} bytes`],
      [useCpqoi ? "First Payload" : "First Stride", String(useCpqoi ? firstFrameMeta.bytes : firstFrameMeta.stride)],
    ]);

    setProgress(100);
    setStatus("GMPAK ready for download.");
    downloadButton.disabled = false;
  } catch (error) {
    setStatus(error.message || String(error), true);
    setProgress(0);
  } finally {
    buildButton.disabled = !state.inputFile;
  }
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
}

dropzone.addEventListener("drop", async (event) => {
  const [file] = event.dataTransfer?.files || [];
  if (file) {
    await handleFile(file);
  }
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (file) {
    await handleFile(file);
  }
});

buildButton.addEventListener("click", buildGmpakFromVideo);

downloadButton.addEventListener("click", () => {
  if (!state.downloadBlob || !state.manifest) {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = state.downloadBlob;
  anchor.download = state.manifest.output_name;
  anchor.click();
});

clearFramePreview();
updateFacts();
ensureFfmpegLoaded().catch((error) => {
  setStatus(error.message || String(error), true);
  setProgress(0);
});
