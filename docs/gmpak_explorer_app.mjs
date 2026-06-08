import {
  CG_FORMATS,
  convertImageDataToCg,
  decodeCgImage,
  packGintPayload,
  parseFxconvPy,
  toFxconvPy,
  toHexDump,
  toHexJson,
} from "./fxconv_cg.mjs";
import {
  convertImageDataToFx,
  decodeFxImage,
  FX_FORMATS,
  isFxFormatName,
  packFxPayload,
  parseFxPayload,
  toFxImageHexJson,
  toFxImagePy,
} from "./fxconv_fx.mjs";
import {
  GMPAK_ENTRY_TYPES,
  GMPAK_ENTRY_TYPE_NAMES,
  parseGintPayload,
  parseGmpak,
  rebuildGmpakFromEntries,
} from "./gmpak_browser.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const HEX_PREVIEW_LIMIT = 1024;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const replaceInput = document.getElementById("replaceInput");
const imageReplaceInput = document.getElementById("imageReplaceInput");
const addEntryInput = document.getElementById("addEntryInput");
const newEntryNameInput = document.getElementById("newEntryName");
const newEntryTypeSelect = document.getElementById("newEntryType");
const addEntryBtn = document.getElementById("addEntryBtn");
const downloadPackBtn = document.getElementById("downloadPackBtn");
const extractEntryBtn = document.getElementById("extractEntryBtn");
const replaceEntryBtn = document.getElementById("replaceEntryBtn");
const removeEntryBtn = document.getElementById("removeEntryBtn");
const statusEl = document.getElementById("status");
const factsEl = document.getElementById("facts");
const entryListEl = document.getElementById("entryList");
const entryNameInput = document.getElementById("entryNameInput");
const entryTypeSelect = document.getElementById("entryTypeSelect");
const applyHeaderBtn = document.getElementById("applyHeaderBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const downloadPyBtn = document.getElementById("downloadPyBtn");
const downloadPngBtn = document.getElementById("downloadPngBtn");
const replacePngBtn = document.getElementById("replacePngBtn");
const entryFactsEl = document.getElementById("entryFacts");
const previewCanvas = document.getElementById("previewCanvas");
const inspectorNotes = document.getElementById("inspectorNotes");
const textSection = document.getElementById("textSection");
const textEditor = document.getElementById("textEditor");
const saveTextBtn = document.getElementById("saveTextBtn");
const gintSection = document.getElementById("gintSection");
const gintFormatSelect = document.getElementById("gintFormatSelect");
const gintJsonEditor = document.getElementById("gintJsonEditor");
const applyGintJsonBtn = document.getElementById("applyGintJsonBtn");
const gintHexPreview = document.getElementById("gintHexPreview");
const binarySection = document.getElementById("binarySection");
const binaryHexPreview = document.getElementById("binaryHexPreview");

const state = {
  parsed: null,
  entries: [],
  selectedIndex: -1,
  downloadUrl: null,
  outputName: "edited.gmpak",
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function sanitizeEntryName(name, fallback = "ENTRY") {
  const ascii = Array.from(String(name))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .join("")
    .trim();
  return (ascii || fallback).slice(0, 16);
}

function sanitizeFilename(name, fallback = "pack") {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || fallback;
}

function sanitizePythonName(name, fallback = "image") {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return prefixed || fallback;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString()} bytes`;
}

function entryTypeOptions() {
  return Object.entries(GMPAK_ENTRY_TYPES)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.value - b.value);
}

function buildTypeSelect(select) {
  select.innerHTML = entryTypeOptions()
    .map(({ label, value }) => `<option value="${value}">${label} (${value})</option>`)
    .join("");
}

function currentEntry() {
  return state.entries[state.selectedIndex] || null;
}

function revokeDownloadUrl() {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}

function clearCanvas() {
  const context = previewCanvas.getContext("2d");
  previewCanvas.width = 1;
  previewCanvas.height = 1;
  context.clearRect(0, 0, 1, 1);
}

function renderCanvas(image) {
  const decoded = image.family === "fx" ? decodeFxImage(image) : decodeCgImage(image);
  const context = previewCanvas.getContext("2d");
  const imageData = new ImageData(decoded.data, decoded.width, decoded.height);
  previewCanvas.width = decoded.width;
  previewCanvas.height = decoded.height;
  context.putImageData(imageData, 0, 0);
}

function payloadHexPreview(bytes, label) {
  const slice = bytes.slice(0, HEX_PREVIEW_LIMIT);
  const suffix = bytes.length > HEX_PREVIEW_LIMIT ? `\n\n... truncated after ${HEX_PREVIEW_LIMIT} bytes` : "";
  return `${label} (${bytes.length} bytes)\n${toHexDump(slice)}${suffix}`;
}

function inferContainerNotes(entries) {
  const metaEntry = entries.find((entry) => entry.type === GMPAK_ENTRY_TYPES.META && entry.meta);
  const imageEntries = entries.filter((entry) =>
    (entry.type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE && entry.gint)
    || (entry.type === GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE && entry.fx)
  );
  const frameNamedEntries = entries.filter((entry) => /^FRM_\d{4}$/i.test(entry.name));
  const isVideoLike = Boolean(metaEntry && imageEntries.length > 0 && frameNamedEntries.length > 0);
  const lines = [];

  if (isVideoLike) {
    lines.push("Detected as a video-oriented GMPAK.");
    lines.push(`fps=${metaEntry.meta.fps ?? "?"}`);
    lines.push(`frames=${metaEntry.meta.frames ?? imageEntries.length}`);
    lines.push(`dimensions=${metaEntry.meta.width ?? imageEntries[0]?.gint?.width ?? imageEntries[0]?.fx?.width ?? "?"}x${metaEntry.meta.height ?? imageEntries[0]?.gint?.height ?? imageEntries[0]?.fx?.height ?? "?"}`);
  } else {
    lines.push("Detected as a generic/custom GMPAK container.");
  }

  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.typeName, (counts.get(entry.typeName) || 0) + 1);
  }

  lines.push("");
  lines.push("Type counts:");
  for (const [typeName, count] of counts) {
    lines.push(`- ${typeName}: ${count}`);
  }

  return lines.join("\n");
}

function hydrateEntry(base, index = 0) {
  const payload = base.payload instanceof Uint8Array ? base.payload : new Uint8Array(base.payload);
  const entry = {
    index,
    name: sanitizeEntryName(base.name || `ENTRY_${index}`),
    type: Number(base.type),
    typeName: GMPAK_ENTRY_TYPE_NAMES[Number(base.type)] || `TYPE_${base.type}`,
    offset: base.offset ?? 0,
    length: payload.length,
    payload,
    payloadKind: "binary",
    modified: Boolean(base.modified),
  };

  if (entry.type === GMPAK_ENTRY_TYPES.META) {
    entry.payloadKind = "meta";
    entry.text = textDecoder.decode(payload);
    entry.meta = {};
    for (const line of entry.text.split(/\r?\n/)) {
      if (!line.includes("=")) continue;
      const [key, value] = line.split("=", 2);
      entry.meta[key] = value;
    }
  } else if (entry.type === GMPAK_ENTRY_TYPES.SUBTITLE) {
    entry.payloadKind = "subtitle";
    entry.text = textDecoder.decode(payload);
  } else if (entry.type === GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE) {
    try {
      entry.payloadKind = "fx";
      entry.fx = parseFxPayload(payload);
    } catch (error) {
      entry.payloadKind = "binary";
      entry.parseError = error.message || String(error);
    }
  } else if (entry.type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE) {
    try {
      entry.payloadKind = "gint";
      entry.gint = parseGintPayload(payload);
    } catch (error) {
      entry.payloadKind = "binary";
      entry.parseError = error.message || String(error);
    }
  }

  return entry;
}

function reindexEntries() {
  state.entries = state.entries.map((entry, index) => hydrateEntry(entry, index));
}

function refreshDownloadBlob() {
  if (!state.parsed || state.entries.length === 0) {
    revokeDownloadUrl();
    downloadPackBtn.disabled = true;
    return;
  }

  const rebuilt = rebuildGmpakFromEntries(state.parsed, state.entries);
  revokeDownloadUrl();
  state.downloadUrl = URL.createObjectURL(new Blob([rebuilt], { type: "application/octet-stream" }));
  downloadPackBtn.disabled = false;
}

function updateFacts() {
  addEntryBtn.disabled = !state.parsed;
  if (!state.parsed) {
    factsEl.innerHTML = "";
    return;
  }

  const rebuilt = state.entries.length > 0 ? rebuildGmpakFromEntries(state.parsed, state.entries) : null;
  const modifiedCount = state.entries.filter((entry) => entry.modified).length;
  const videoLike = inferContainerNotes(state.entries).startsWith("Detected as a video-oriented");

  const facts = [
    ["Input", state.outputName],
    ["Entries", String(state.entries.length)],
    ["Version", String(state.parsed.version)],
    ["Original Size", formatBytes(state.parsed.size)],
    ["Rebuilt Size", rebuilt ? formatBytes(rebuilt.length) : "n/a"],
    ["Modified", String(modifiedCount)],
    ["Kind", videoLike ? "Video pack" : "Custom pack"],
  ];

  factsEl.innerHTML = facts
    .map(([label, value]) => `<div class="fact"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function updateEntryFacts(entry) {
  if (!entry) {
    entryFactsEl.innerHTML = "";
    return;
  }

  const facts = [
    ["Kind", entry.payloadKind],
    ["Type", entry.typeName],
    ["Size", formatBytes(entry.length)],
  ];

  if (entry.payloadKind === "gint" && entry.gint) {
    facts.push(["Profile", `${entry.gint.profile}`]);
    facts.push(["Frame", `${entry.gint.width} x ${entry.gint.height}`]);
    facts.push(["Stride", `${entry.gint.stride}`]);
    facts.push(["Colors", `${entry.gint.colorCount}`]);
    facts.push(["Palette", formatBytes(entry.gint.palette.length)]);
    facts.push(["Data", formatBytes(entry.gint.data.length)]);
  } else if (entry.payloadKind === "fx" && entry.fx) {
    facts.push(["Profile", `${entry.fx.profile}`]);
    facts.push(["Frame", `${entry.fx.width} x ${entry.fx.height}`]);
    facts.push(["Layers", `${entry.fx.layerCount}`]);
    facts.push(["Colors", `${entry.fx.colorCount}`]);
    facts.push(["Data", formatBytes(entry.fx.data.length)]);
  }

  entryFactsEl.innerHTML = facts
    .map(([label, value]) => `<div class="fact"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderEntryList() {
  if (state.entries.length === 0) {
    entryListEl.innerHTML = `<div class="empty">No entries loaded yet.</div>`;
    return;
  }

  entryListEl.innerHTML = state.entries
    .map((entry, index) => {
      const modifiedTag = entry.modified ? `<span class="tag modified">modified</span>` : "";
      const activeClass = index === state.selectedIndex ? "active" : "";
      return `
        <button class="entry-button ${activeClass}" data-entry-index="${index}">
          <div class="entry-top">
            <strong class="mono">${entry.name}</strong>
            <span class="tag">${entry.typeName}</span>
          </div>
          <div class="entry-bottom">
            <span>${entry.payloadKind}</span>
            <span>${formatBytes(entry.length)}</span>
            ${modifiedTag}
          </div>
        </button>
      `;
    })
    .join("");

  entryListEl.querySelectorAll("[data-entry-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedIndex = Number(button.dataset.entryIndex);
      renderEntryList();
      renderInspector();
    });
  });
}

function setSectionVisibility(entry) {
  textSection.classList.toggle("hidden", !(entry && (entry.payloadKind === "meta" || entry.payloadKind === "subtitle")));
  gintSection.classList.toggle("hidden", !(entry && (entry.payloadKind === "gint" || entry.payloadKind === "fx")));
  binarySection.classList.toggle("hidden", !(entry && entry.payloadKind === "binary"));
}

function updateButtonStates(entry) {
  const hasEntry = Boolean(entry);
  extractEntryBtn.disabled = !hasEntry;
  replaceEntryBtn.disabled = !hasEntry;
  removeEntryBtn.disabled = !hasEntry;
  applyHeaderBtn.disabled = !hasEntry;
  entryNameInput.disabled = !hasEntry;
  entryTypeSelect.disabled = !hasEntry;
  downloadJsonBtn.disabled = !(entry && (entry.payloadKind === "gint" || entry.payloadKind === "fx"));
  downloadPyBtn.disabled = !(entry && (entry.payloadKind === "gint" || entry.payloadKind === "fx"));
  downloadPngBtn.disabled = !(entry && (entry.payloadKind === "gint" || entry.payloadKind === "fx"));
  replacePngBtn.disabled = !(entry && (entry.payloadKind === "gint" || entry.payloadKind === "fx"));
}

function formatNameForProfile(profile) {
  return CG_FORMATS.find((format) => format.id === profile)?.names?.[0] || "";
}

function renderInspector() {
  const entry = currentEntry();
  updateButtonStates(entry);
  updateEntryFacts(entry);
  setSectionVisibility(entry);
  inspectorNotes.value = state.entries.length > 0 ? inferContainerNotes(state.entries) : "";

  if (!entry) {
    entryNameInput.value = "";
    entryTypeSelect.value = String(GMPAK_ENTRY_TYPES.META);
    textEditor.value = "";
    gintJsonEditor.value = "";
    gintHexPreview.value = "";
    binaryHexPreview.value = "";
    clearCanvas();
    return;
  }

  entryNameInput.value = entry.name;
  entryTypeSelect.value = String(entry.type);

  if (entry.payloadKind === "meta" || entry.payloadKind === "subtitle") {
    textEditor.value = entry.text ?? textDecoder.decode(entry.payload);
  } else {
    textEditor.value = "";
  }

  if (entry.payloadKind === "gint" && entry.gint) {
    renderCanvas(entry.gint);
    gintFormatSelect.value = formatNameForProfile(entry.gint.profile);
    gintJsonEditor.value = JSON.stringify(toHexJson(entry.gint), null, 2);
    gintHexPreview.value = [
      payloadHexPreview(entry.gint.palette, "palette"),
      "",
      payloadHexPreview(entry.gint.data, "data"),
    ].join("\n");
    binaryHexPreview.value = "";
  } else if (entry.payloadKind === "fx" && entry.fx) {
    renderCanvas(entry.fx);
    gintFormatSelect.value = entry.fx.formatName;
    gintJsonEditor.value = JSON.stringify(toFxImageHexJson(entry.fx), null, 2);
    gintHexPreview.value = payloadHexPreview(entry.fx.data, "data");
    binaryHexPreview.value = "";
  } else {
    clearCanvas();
    gintJsonEditor.value = "";
    gintHexPreview.value = "";
  }

  if (entry.payloadKind === "binary") {
    const preview = payloadHexPreview(entry.payload, "payload");
    binaryHexPreview.value = entry.parseError ? `${entry.parseError}\n\n${preview}` : preview;
  } else {
    binaryHexPreview.value = "";
  }
}

function refreshUi() {
  reindexEntries();
  if (state.selectedIndex >= state.entries.length) {
    state.selectedIndex = state.entries.length - 1;
  }
  renderEntryList();
  updateFacts();
  refreshDownloadBlob();
  renderInspector();
}

function mutateEntry(index, next) {
  state.entries[index] = hydrateEntry({ ...next, modified: true }, index);
  refreshUi();
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 250);
}

function hexToBytes(hexString) {
  const cleaned = hexString.replace(/\s+/g, "");
  if (cleaned.length % 2 !== 0) {
    throw new Error("Hex string length must be even");
  }
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
    throw new Error("Hex string contains non-hex characters");
  }

  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = Number.parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

function parseHexJsonResource(source) {
  const parsed = JSON.parse(source);
  if ((parsed.family ?? "").toLowerCase() === "fx" || parsed.layer_count !== undefined || parsed.format_name !== undefined) {
    return {
      family: "fx",
      profile: Number(parsed.profile),
      formatName: String(parsed.format_name ?? ""),
      width: Number(parsed.width),
      height: Number(parsed.height),
      layerCount: Number(parsed.layer_count ?? 0),
      colorCount: Number(parsed.color_count ?? 0),
      data: hexToBytes(parsed.data_hex ?? parsed.dataHex ?? ""),
    };
  }
  const colorCount = Number(parsed.color_count ?? parsed.colorCount);
  return {
    profile: Number(parsed.profile),
    colorCount,
    width: Number(parsed.width),
    height: Number(parsed.height),
    stride: Number(parsed.stride),
    palette: hexToBytes(parsed.palette_hex ?? parsed.paletteHex ?? ""),
    data: hexToBytes(parsed.data_hex ?? parsed.dataHex ?? ""),
  };
}

function guessPayloadFilename(entry) {
  const base = sanitizeFilename(entry.name.toLowerCase() || `entry_${entry.index}`);
  if (entry.payloadKind === "meta" || entry.payloadKind === "subtitle") {
    return `${base}.txt`;
  }
  if (entry.payloadKind === "gint") {
    return `${base}.gint.bin`;
  }
  if (entry.payloadKind === "fx") {
    return `${base}.fx.bin`;
  }
  return `${base}.bin`;
}

async function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

async function readFileAsText(file) {
  return file.text();
}

async function handlePackFile(file) {
  try {
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const parsed = parseGmpak(bytes);
    state.parsed = parsed;
    state.entries = parsed.entries.map((entry, index) => hydrateEntry(entry, index));
    state.selectedIndex = state.entries.length > 0 ? 0 : -1;
    state.outputName = sanitizeFilename(file.name || "edited.gmpak", "edited.gmpak");
    refreshUi();
    setStatus(`Loaded ${file.name} with ${state.entries.length} entries.`);
  } catch (error) {
    state.parsed = null;
    state.entries = [];
    state.selectedIndex = -1;
    revokeDownloadUrl();
    refreshUi();
    setStatus(error.message || String(error), true);
  }
}

async function replaceEntryFromFile(file) {
  const entry = currentEntry();
  if (!entry) {
    return;
  }

  try {
    let payload;
    if (entry.payloadKind === "meta" || entry.payloadKind === "subtitle") {
      payload = textEncoder.encode(await readFileAsText(file));
    } else if (entry.type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE || entry.type === GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE) {
      const lower = file.name.toLowerCase();
      if (entry.type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE && lower.endsWith(".py")) {
        payload = packGintPayload(parseFxconvPy(await readFileAsText(file)));
      } else if (lower.endsWith(".json")) {
        const parsed = parseHexJsonResource(await readFileAsText(file));
        payload = parsed.family === "fx" ? packFxPayload(parsed) : packGintPayload(parsed);
      } else {
        payload = new Uint8Array(await readFileAsArrayBuffer(file));
      }
    } else {
      payload = new Uint8Array(await readFileAsArrayBuffer(file));
    }

    mutateEntry(state.selectedIndex, { ...entry, payload });
    setStatus(`Replaced ${entry.name} from ${file.name}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function loadImageDataFromFile(file, targetWidth, targetHeight) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, targetWidth, targetHeight);
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  return context.getImageData(0, 0, targetWidth, targetHeight);
}

async function replaceGintFromImage(file) {
  const entry = currentEntry();
  if (!entry || !["gint", "fx"].includes(entry.payloadKind)) {
    return;
  }

  try {
    const source = entry.payloadKind === "fx" ? entry.fx : entry.gint;
    const imageData = await loadImageDataFromFile(file, source.width, source.height);
    const converted = isFxFormatName(gintFormatSelect.value)
      ? convertImageDataToFx(imageData, gintFormatSelect.value)
      : convertImageDataToCg(imageData, gintFormatSelect.value);
    mutateEntry(state.selectedIndex, {
      ...entry,
      type: converted.family === "fx" ? GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE : GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE,
      payload: converted.family === "fx" ? packFxPayload(converted) : packGintPayload(converted),
    });
    setStatus(`Replaced ${entry.name} with ${file.name} using ${converted.formatName}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function appendEntryFromFile(file) {
  if (!state.parsed) {
    setStatus("Load a GMPAK before appending entries.", true);
    return;
  }

  try {
    const type = Number(newEntryTypeSelect.value);
    const name = sanitizeEntryName(newEntryNameInput.value || file.name.replace(/\.[^.]+$/, ""), "RESOURCE");
    const lower = file.name.toLowerCase();
    let payload;

    if (type === GMPAK_ENTRY_TYPES.META || type === GMPAK_ENTRY_TYPES.SUBTITLE) {
      payload = textEncoder.encode(await readFileAsText(file));
    } else if (type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE && lower.endsWith(".py")) {
      payload = packGintPayload(parseFxconvPy(await readFileAsText(file)));
    } else if ((type === GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE || type === GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE) && lower.endsWith(".json")) {
      const parsed = parseHexJsonResource(await readFileAsText(file));
      payload = parsed.family === "fx" ? packFxPayload(parsed) : packGintPayload(parsed);
    } else {
      payload = new Uint8Array(await readFileAsArrayBuffer(file));
    }

    state.entries.push(hydrateEntry({ name, type, payload, modified: true }, state.entries.length));
    state.selectedIndex = state.entries.length - 1;
    refreshUi();
    setStatus(`Appended ${name} from ${file.name}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function applyEntryHeader() {
  const entry = currentEntry();
  if (!entry) {
    return;
  }

  mutateEntry(state.selectedIndex, {
    ...entry,
    name: sanitizeEntryName(entryNameInput.value || entry.name),
    type: Number(entryTypeSelect.value),
    payload: entry.payload,
  });
  setStatus(`Updated header for ${entry.name}.`);
}

function saveTextPayload() {
  const entry = currentEntry();
  if (!entry) {
    return;
  }

  mutateEntry(state.selectedIndex, {
    ...entry,
    payload: textEncoder.encode(textEditor.value),
  });
  setStatus(`Saved text payload for ${entry.name}.`);
}

function applyGintJson() {
  const entry = currentEntry();
  if (!entry) {
    return;
  }

  try {
    const parsed = parseHexJsonResource(gintJsonEditor.value);
    mutateEntry(state.selectedIndex, {
      ...entry,
      type: parsed.family === "fx" ? GMPAK_ENTRY_TYPES.VIDEO_FX_IMAGE : GMPAK_ENTRY_TYPES.VIDEO_GINT_IMAGE,
      payload: parsed.family === "fx" ? packFxPayload(parsed) : packGintPayload(parsed),
    });
    setStatus(`Applied hex JSON to ${entry.name}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function removeSelectedEntry() {
  const entry = currentEntry();
  if (!entry) {
    return;
  }

  state.entries.splice(state.selectedIndex, 1);
  if (state.entries.length === 0) {
    state.selectedIndex = -1;
  } else if (state.selectedIndex >= state.entries.length) {
    state.selectedIndex = state.entries.length - 1;
  }
  refreshUi();
  setStatus(`Removed ${entry.name}.`);
}

function downloadSelectedPayload() {
  const entry = currentEntry();
  if (!entry) {
    return;
  }
  downloadBlob(new Blob([entry.payload], { type: "application/octet-stream" }), guessPayloadFilename(entry));
}

function downloadSelectedJson() {
  const entry = currentEntry();
  if (!entry || !["gint", "fx"].includes(entry.payloadKind)) {
    return;
  }
  downloadBlob(
    new Blob([`${JSON.stringify(entry.payloadKind === "fx" ? toFxImageHexJson(entry.fx) : toHexJson(entry.gint), null, 2)}\n`], { type: "application/json" }),
    `${sanitizeFilename(entry.name.toLowerCase(), "image")}.json`
  );
}

function downloadSelectedPy() {
  const entry = currentEntry();
  if (!entry || !["gint", "fx"].includes(entry.payloadKind)) {
    return;
  }
  downloadBlob(
    new Blob([(entry.payloadKind === "fx" ? toFxImagePy(entry.fx, sanitizePythonName(entry.name.toLowerCase(), "image")) : toFxconvPy(entry.gint, sanitizePythonName(entry.name.toLowerCase(), "image")))], { type: "text/x-python" }),
    `${sanitizeFilename(entry.name.toLowerCase(), "image")}.py`
  );
}

function downloadSelectedPng() {
  const entry = currentEntry();
  if (!entry || !["gint", "fx"].includes(entry.payloadKind)) {
    return;
  }

  previewCanvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `${sanitizeFilename(entry.name.toLowerCase(), "image")}.png`);
  }, "image/png");
}

function downloadCurrentPack() {
  if (!state.downloadUrl) {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = state.downloadUrl;
  anchor.download = state.outputName.endsWith(".gmpak") ? state.outputName : `${state.outputName}.gmpak`;
  anchor.click();
}

function populateFormatSelect() {
  gintFormatSelect.innerHTML = [
    ...CG_FORMATS.map((format) => format.names[0]),
    ...FX_FORMATS.map((format) => format.name),
  ]
    .map((name) => `<option value="${name}">${name}</option>`)
    .join("");
}

buildTypeSelect(newEntryTypeSelect);
buildTypeSelect(entryTypeSelect);
populateFormatSelect();
clearCanvas();
addEntryBtn.disabled = true;
updateFacts();
updateEntryFacts(null);
inspectorNotes.value = "";

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
    await handlePackFile(file);
  }
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (file) {
    await handlePackFile(file);
  }
});

replaceInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (file) {
    await replaceEntryFromFile(file);
  }
  replaceInput.value = "";
});

imageReplaceInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (file) {
    await replaceGintFromImage(file);
  }
  imageReplaceInput.value = "";
});

addEntryInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (file) {
    await appendEntryFromFile(file);
  }
  addEntryInput.value = "";
});

downloadPackBtn.addEventListener("click", downloadCurrentPack);
extractEntryBtn.addEventListener("click", downloadSelectedPayload);
replaceEntryBtn.addEventListener("click", () => replaceInput.click());
removeEntryBtn.addEventListener("click", removeSelectedEntry);
addEntryBtn.addEventListener("click", () => addEntryInput.click());
applyHeaderBtn.addEventListener("click", applyEntryHeader);
saveTextBtn.addEventListener("click", saveTextPayload);
applyGintJsonBtn.addEventListener("click", applyGintJson);
downloadJsonBtn.addEventListener("click", downloadSelectedJson);
downloadPyBtn.addEventListener("click", downloadSelectedPy);
downloadPngBtn.addEventListener("click", downloadSelectedPng);
replacePngBtn.addEventListener("click", () => imageReplaceInput.click());
