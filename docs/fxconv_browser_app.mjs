import {
  convertImageDataToCg,
  decodeCgImage,
  toFxconvPy,
  toHexJson,
} from "./fxconv_cg.mjs";
import {
  convertImageDataToFx,
  decodeFxImage,
  toFxImageHexJson,
  toFxImagePy,
} from "./fxconv_fx.mjs";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const formatSelect = document.getElementById("formatSelect");
const downloadPyButton = document.getElementById("downloadPy");
const downloadJsonButton = document.getElementById("downloadJson");
const fileLine = document.getElementById("fileLine");
const metaGrid = document.getElementById("metaGrid");
const statusEl = document.getElementById("status");
const originalCanvas = document.getElementById("originalCanvas");
const convertedCanvas = document.getElementById("convertedCanvas");
const jsonOutput = document.getElementById("jsonOutput");
const pythonOutput = document.getElementById("pythonOutput");

const state = {
  file: null,
  imageData: null,
  converted: null,
  jsonText: "",
  pythonText: "",
};

function sanitizeName(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
  return cleaned || "image";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function clearCanvas(canvas) {
  const context = canvas.getContext("2d");
  canvas.width = 1;
  canvas.height = 1;
  context.clearRect(0, 0, 1, 1);
}

function renderImageDataToCanvas(canvas, imageDataLike) {
  const context = canvas.getContext("2d");
  const imageData = new ImageData(imageDataLike.data, imageDataLike.width, imageDataLike.height);
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  context.putImageData(imageData, 0, 0);
}

function updateMeta(converted) {
  const entries = converted.family === "fx"
    ? [
        ["Target", "fx-9860G"],
        ["Resolved Format", converted.formatName],
        ["Profile", String(converted.profile)],
        ["Size", `${converted.width} x ${converted.height}`],
        ["Layers", String(converted.layerCount)],
        ["Color Count", String(converted.colorCount)],
        ["Data Bytes", String(converted.data.length)],
      ]
    : (() => {
        const json = toHexJson(converted);
        return [
          ["Target", "fx-CG 50"],
          ["Resolved Format", converted.formatName],
          ["Profile", String(json.profile)],
          ["Color Count", String(json.color_count)],
          ["Size", `${json.width} x ${json.height}`],
          ["Stride", String(json.stride)],
          ["Data Bytes", String(json.data_hex.length / 2)],
          ["Palette Bytes", String(json.palette_hex.length / 2)],
        ];
      })();

  metaGrid.innerHTML = entries
    .map(([label, value]) => `<div class="meta-card"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function clearOutputs() {
  state.converted = null;
  state.jsonText = "";
  state.pythonText = "";
  jsonOutput.value = "";
  pythonOutput.value = "";
  metaGrid.innerHTML = "";
  downloadPyButton.disabled = true;
  downloadJsonButton.disabled = true;
  clearCanvas(convertedCanvas);
}

function downloadText(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function refreshConversion() {
  if (!state.imageData || !state.file) {
    clearOutputs();
    return;
  }

  try {
    const imageName = sanitizeName(state.file.name);
    const isFxFormat = formatSelect.value === "fx:auto"
      || formatSelect.value === "mono"
      || formatSelect.value === "mono_alpha"
      || formatSelect.value === "gray"
      || formatSelect.value === "gray_alpha";
    const converted = isFxFormat
      ? convertImageDataToFx(state.imageData, formatSelect.value)
      : convertImageDataToCg(state.imageData, formatSelect.value);
    const decoded = isFxFormat ? decodeFxImage(converted) : decodeCgImage(converted);
    const json = isFxFormat ? toFxImageHexJson(converted) : toHexJson(converted);

    state.converted = converted;
    state.jsonText = JSON.stringify(json, null, 2);
    state.pythonText = isFxFormat ? toFxImagePy(converted, imageName) : toFxconvPy(converted, imageName);

    renderImageDataToCanvas(convertedCanvas, decoded);
    updateMeta(converted);
    jsonOutput.value = state.jsonText;
    pythonOutput.value = state.pythonText;
    downloadPyButton.disabled = false;
    downloadJsonButton.disabled = false;
    setStatus("Conversion ready.");
  } catch (error) {
    clearOutputs();
    setStatus(error.message || String(error), true);
  }
}

async function loadFile(file) {
  const bitmap = await createImageBitmap(file);
  const context = originalCanvas.getContext("2d");
  originalCanvas.width = bitmap.width;
  originalCanvas.height = bitmap.height;
  context.clearRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  state.file = file;
  state.imageData = context.getImageData(0, 0, originalCanvas.width, originalCanvas.height);
  fileLine.textContent = `${file.name} • ${originalCanvas.width} x ${originalCanvas.height}`;
  refreshConversion();
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }
  await loadFile(file);
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
  if (!file) {
    return;
  }
  await loadFile(file);
});

formatSelect.addEventListener("change", refreshConversion);

downloadPyButton.addEventListener("click", () => {
  if (!state.file || !state.pythonText) {
    return;
  }
  downloadText(`${sanitizeName(state.file.name)}.py`, state.pythonText, "text/x-python");
});

downloadJsonButton.addEventListener("click", () => {
  if (!state.file || !state.jsonText) {
    return;
  }
  downloadText(`${sanitizeName(state.file.name)}.json`, state.jsonText, "application/json");
});

clearCanvas(originalCanvas);
clearCanvas(convertedCanvas);
setStatus("Load an image to begin.");
