import { CORE_URL, FFMessageType } from "./ffmpeg_wasm_const.js";
import {
  ERROR_IMPORT_FAILURE,
  ERROR_NOT_LOADED,
  ERROR_UNKNOWN_MESSAGE_TYPE,
} from "./ffmpeg_wasm_errors.js";

let ffmpeg;

const load = async ({ coreURL: requestedCoreURL, wasmURL: requestedWasmURL, workerURL: requestedWorkerURL }) => {
  const first = !ffmpeg;
  const coreURL = requestedCoreURL || CORE_URL;

  self.createFFmpegCore = (await import(/* @vite-ignore */ coreURL)).default;
  if (!self.createFFmpegCore) {
    throw ERROR_IMPORT_FAILURE;
  }

  const wasmURL = requestedWasmURL || coreURL.replace(/\.js$/g, ".wasm");
  const workerURL = requestedWorkerURL || coreURL.replace(/\.js$/g, ".worker.js");

  ffmpeg = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
  });

  ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
  ffmpeg.setProgress((data) => self.postMessage({ type: FFMessageType.PROGRESS, data }));
  return first;
};

const exec = ({ args, timeout = -1 }) => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const ffprobe = ({ args, timeout = -1 }) => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const writeFile = ({ path, data }) => {
  ffmpeg.FS.writeFile(path, data);
  return true;
};

const readFile = ({ path, encoding }) => ffmpeg.FS.readFile(path, { encoding });

const deleteFile = ({ path }) => {
  ffmpeg.FS.unlink(path);
  return true;
};

const rename = ({ oldPath, newPath }) => {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
};

const createDir = ({ path }) => {
  ffmpeg.FS.mkdir(path);
  return true;
};

const listDir = ({ path }) => {
  const names = ffmpeg.FS.readdir(path);
  const nodes = [];
  for (const name of names) {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    nodes.push({ name, isDir: ffmpeg.FS.isDir(stat.mode) });
  }
  return nodes;
};

const deleteDir = ({ path }) => {
  ffmpeg.FS.rmdir(path);
  return true;
};

const mount = ({ fsType, options, mountPoint }) => {
  const fs = ffmpeg.FS.filesystems[fsType];
  if (!fs) {
    return false;
  }
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
};

const unmount = ({ mountPoint }) => {
  ffmpeg.FS.unmount(mountPoint);
  return true;
};

self.onmessage = async ({ data: { id, type, data: payload } }) => {
  const transfers = [];
  let result;

  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) {
      throw ERROR_NOT_LOADED;
    }

    switch (type) {
      case FFMessageType.LOAD:
        result = await load(payload);
        break;
      case FFMessageType.EXEC:
        result = exec(payload);
        break;
      case FFMessageType.FFPROBE:
        result = ffprobe(payload);
        break;
      case FFMessageType.WRITE_FILE:
        result = writeFile(payload);
        break;
      case FFMessageType.READ_FILE:
        result = readFile(payload);
        break;
      case FFMessageType.DELETE_FILE:
        result = deleteFile(payload);
        break;
      case FFMessageType.RENAME:
        result = rename(payload);
        break;
      case FFMessageType.CREATE_DIR:
        result = createDir(payload);
        break;
      case FFMessageType.LIST_DIR:
        result = listDir(payload);
        break;
      case FFMessageType.DELETE_DIR:
        result = deleteDir(payload);
        break;
      case FFMessageType.MOUNT:
        result = mount(payload);
        break;
      case FFMessageType.UNMOUNT:
        result = unmount(payload);
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (error) {
    self.postMessage({
      id,
      type: FFMessageType.ERROR,
      data: error.toString(),
    });
    return;
  }

  if (result instanceof Uint8Array) {
    transfers.push(result.buffer);
  }

  self.postMessage({ id, type, data: result }, transfers);
};
