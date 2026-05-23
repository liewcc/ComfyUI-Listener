const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── PNG Metadata Helpers ──────────────────────────────────────────────────────
// CRC32 lookup table for PNG chunk integrity
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function pngCrc32(buf, offset, length) {
  let crc = 0xFFFFFFFF;
  for (let i = offset; i < offset + length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Create a PNG iTXt chunk (UTF-8, uncompressed) — safe for CJK characters
function makePngITXtChunk(keyword, text) {
  const keyBuf  = Buffer.from(keyword, 'latin1');
  const textBuf = Buffer.from(text, 'utf8');
  // iTXt layout: keyword \0 comprFlag(0) comprMethod(0) langTag \0 transKeyword \0 text
  const data = Buffer.concat([
    keyBuf, Buffer.from([0, 0, 0, 0, 0]), textBuf
  ]);
  const type = Buffer.from('iTXt');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(pngCrc32(Buffer.concat([type, data]), 0, 4 + data.length), 0);
  return Buffer.concat([lenBuf, type, data, crcBuf]);
}

// Insert iTXt chunks into a PNG buffer just before the IEND chunk.
// Keys that already exist in the PNG are NOT overwritten, so ComfyUI's
// native 'workflow' (web-UI JSON) written by SaveImage nodes is preserved.
function injectPngMetadata(pngBuf, metadataObj) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!pngBuf.slice(0, 8).equals(PNG_SIG)) return pngBuf; // not a PNG

  // Collect keys that are already present so we never overwrite them
  const existingKeys = new Set(Object.keys(extractPngTextChunks(pngBuf)));

  let pos = 8, iendPos = -1;
  while (pos + 12 <= pngBuf.length) {
    const chunkLen  = pngBuf.readUInt32BE(pos);
    const chunkType = pngBuf.slice(pos + 4, pos + 8).toString('ascii');
    if (chunkType === 'IEND') { iendPos = pos; break; }
    pos += 12 + chunkLen;
  }
  if (iendPos === -1) return pngBuf;

  const newChunks = Object.entries(metadataObj)
    .filter(([k, v]) => v != null && String(v).length > 0 && !existingKeys.has(k))
    .map(([k, v]) => makePngITXtChunk(k, String(v)));

  if (newChunks.length === 0) return pngBuf; // nothing to add
  return Buffer.concat([pngBuf.slice(0, iendPos), ...newChunks, pngBuf.slice(iendPos)]);
}

// Extract all tEXt and iTXt chunks from a PNG buffer
function extractPngTextChunks(pngBuf) {
  const result = {};
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!pngBuf || pngBuf.length < 8 || !pngBuf.slice(0, 8).equals(PNG_SIG)) return result;

  let pos = 8;
  while (pos + 12 <= pngBuf.length) {
    const chunkLen  = pngBuf.readUInt32BE(pos);
    const chunkType = pngBuf.slice(pos + 4, pos + 8).toString('ascii');
    const dataStart = pos + 8;
    const dataEnd   = dataStart + chunkLen;

    if (chunkType === 'tEXt') {
      const data = pngBuf.slice(dataStart, dataEnd);
      const nil  = data.indexOf(0);
      if (nil !== -1) result[data.slice(0, nil).toString('latin1')] = data.slice(nil + 1).toString('latin1');
    } else if (chunkType === 'iTXt') {
      const data = pngBuf.slice(dataStart, dataEnd);
      const nil  = data.indexOf(0);
      if (nil !== -1) {
        const kw = data.slice(0, nil).toString('latin1');
        let p = nil + 3; // skip comprFlag, comprMethod
        p = data.indexOf(0, p) + 1; // skip language tag
        p = data.indexOf(0, p) + 1; // skip translated keyword
        result[kw] = data.slice(p).toString('utf8');
      }
    } else if (chunkType === 'IEND') break;

    pos += 12 + chunkLen;
  }
  return result;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    },
    // Premium frame design
    backgroundColor: '#0b0f19',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Open DevTools to verify correct renderer.js is loaded (temporary)
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (mainWindow === null) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers for local files and workflows
ipcMain.handle('select-workflow-file', async () => {
  const defaultPath = path.join(app.getAppPath(), 'workflow');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select ComfyUI API Workflow JSON File',
    defaultPath: defaultPath,
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  try {
    const filePath = result.filePaths[0];
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return {
      fileName: path.basename(filePath),
      filePath: filePath,
      content: JSON.parse(fileContent)
    };
  } catch (err) {
    throw new Error('Failed to read or parse workflow JSON: ' + err.message);
  }
});

// Select an image file for LoadImage node
ipcMain.handle('select-image-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Image File',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  return {
    filePath: filePath,
    fileName: path.basename(filePath)
  };
});

// Upload image to ComfyUI via HTTP API /upload/image
ipcMain.handle('upload-image-to-comfyui', async (event, { filePath, comfyUrl }) => {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.bmp') mimeType = 'image/bmp';

    const blob = new Blob([fileBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append('image', blob, fileName);
    formData.append('overwrite', 'true'); // Prevent ComfyUI from renaming to 3(1).png when file already exists

    const uploadUrl = `${comfyUrl}/upload/image`;
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    return { ok: true, name: data.name };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Select output folder for saving generated images
ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Folder to Auto-Save Generated Images',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Save ComfyUI output image to the selected local directory
// Optional: metadata (object of key→string) will be injected as PNG iTXt chunks
// Optional: sourceImageUrl — if provided its existing PNG text chunks are merged in first
ipcMain.handle('save-image-to-folder', async (event, { url, folderPath, filename, metadata, sourceImageUrl }) => {
  try {
    if (!fs.existsSync(folderPath)) {
      return { ok: false, error: `Folder does not exist: ${folderPath}` };
    }

    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `HTTP Error: ${response.status}` };
    }

    let imgBuffer = Buffer.from(await response.arrayBuffer());

    // Inject PNG metadata if provided and the output is a PNG
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.png' && metadata && typeof metadata === 'object') {
      // Optionally merge metadata from the source/reference image
      let sourceChunks = {};
      if (sourceImageUrl) {
        try {
          const srcResp = await fetch(sourceImageUrl);
          if (srcResp.ok) {
            sourceChunks = extractPngTextChunks(Buffer.from(await srcResp.arrayBuffer()));
          }
        } catch (_) { /* ignore fetch errors for source image */ }
      }

      // Build merged metadata: source image first (lower priority), then our metadata
      const merged = {};
      // Carry over source parameters under a prefixed key
      if (sourceChunks.parameters) merged['source_parameters'] = sourceChunks.parameters;
      if (sourceChunks.workflow)    merged['source_workflow']   = sourceChunks.workflow;
      // Our generated metadata takes priority
      Object.assign(merged, metadata);

      imgBuffer = injectPngMetadata(imgBuffer, merged);
    }

    let targetPath = path.join(folderPath, filename);
    const base = path.basename(filename, ext);
    let counter = 1;

    while (fs.existsSync(targetPath)) {
      targetPath = path.join(folderPath, `${base}_${counter}${ext}`);
      counter++;
    }

    fs.writeFileSync(targetPath, imgBuffer);
    return { ok: true, savedPath: targetPath, filename: path.basename(targetPath) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Check if file exists in the folder
ipcMain.handle('check-file-exists', async (event, { folderPath, filename }) => {
  try {
    if (!folderPath || !filename) return false;
    const targetPath = path.join(folderPath, filename);
    return fs.existsSync(targetPath);
  } catch (err) {
    return false;
  }
});

// Main process HTTP fetch proxy for ComfyUI API to guarantee bypass of all CORS and browser restrictions
ipcMain.handle('comfy-request', async (event, { url, method = 'GET', body = null, headers = {} }) => {
  try {
    const fetchOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, fetchOptions);
    const ok = response.ok;
    const status = response.status;
    let data = null;
    
    try {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    } catch (e) {
      // Empty or unreadable response
    }
    
    return { ok, status, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Fetch an image from ComfyUI and return it as a base64 data URL for safe in-app display
ipcMain.handle('comfy-fetch-image', async (event, { url }) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/png';
    return { ok: true, dataUrl: `data:${contentType};base64,${base64}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Save a ComfyUI image to a temp file and open it with the OS default image viewer
ipcMain.handle('open-image-in-viewer', async (event, { url, filename }) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const ext = path.extname(filename) || '.png';
    const tmpPath = path.join(os.tmpdir(), `comfyui_preview_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
    await shell.openPath(tmpPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Open a path (file or folder) in default OS explorer/viewer
ipcMain.handle('open-path', async (event, { path: pathToOpen }) => {
  try {
    if (fs.existsSync(pathToOpen)) {
      await shell.openPath(pathToOpen);
      return { ok: true };
    } else {
      return { ok: false, error: 'Path does not exist' };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Write debug log to file (stored next to the app for easy access)
const DEBUG_LOG_PATH = path.join(app.getPath('userData'), 'comfyui_listener_debug.log');
ipcMain.handle('log-debug', async (event, { message }) => {
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
