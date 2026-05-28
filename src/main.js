const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

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
    } else if (chunkType === 'zTXt') {
      const data = pngBuf.slice(dataStart, dataEnd);
      const nil  = data.indexOf(0);
      if (nil !== -1) {
        const kw = data.slice(0, nil).toString('latin1');
        const comprMethod = data[nil + 1];
        const textBuf = data.slice(nil + 2);
        let textVal;
        try {
          textVal = zlib.inflateSync(textBuf).toString('utf8');
        } catch (zlibErr) {
          console.error(`Failed to decompress zTXt chunk ${kw}:`, zlibErr);
          textVal = textBuf.toString('utf8'); // fallback
        }
        result[kw] = textVal;
      }
    } else if (chunkType === 'iTXt') {
      const data = pngBuf.slice(dataStart, dataEnd);
      const nil  = data.indexOf(0);
      if (nil !== -1) {
        const kw = data.slice(0, nil).toString('latin1');
        const comprFlag = data[nil + 1];
        const comprMethod = data[nil + 2];
        let p = nil + 3; // skip comprFlag, comprMethod
        p = data.indexOf(0, p) + 1; // skip language tag
        p = data.indexOf(0, p) + 1; // skip translated keyword
        
        const textBuf = data.slice(p);
        let textVal;
        if (comprFlag === 1) {
          try {
            textVal = zlib.inflateSync(textBuf).toString('utf8');
          } catch (zlibErr) {
            console.error(`Failed to decompress iTXt chunk ${kw}:`, zlibErr);
            textVal = textBuf.toString('utf8'); // fallback
          }
        } else {
          textVal = textBuf.toString('utf8');
        }
        result[kw] = textVal;
      }
    } else if (chunkType === 'IEND') break;

    pos += 12 + chunkLen;
  }
  return result;
}

let mainWindow;
let tray = null;
let isQuitting = false;
let minimizeToTray = false;

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  if (!fs.existsSync(iconPath)) {
    console.error('Tray icon path does not exist:', iconPath);
    return;
  }
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) mainWindow.show();
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip('ComfyUI Listener Control Center');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });
}

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

  mainWindow.on('close', (e) => {
    if (!isQuitting && minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', function () {
    if (mainWindow === null) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('update-minimize-to-tray', (event, enabled) => {
  minimizeToTray = enabled;
});

// Helper to find the matching sister workflow file (api <=> webui)
function getSisterFilePath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  const webuiMatch = base.match(/webui/i);
  const apiMatch = base.match(/api/i);

  let newBase = null;
  if (webuiMatch) {
    newBase = base.replace(/webui/gi, (match) => {
      if (match === 'WEBUI') return 'API';
      if (match === 'Webui') return 'Api';
      return 'api';
    });
  } else if (apiMatch) {
    newBase = base.replace(/api/gi, (match) => {
      if (match === 'API') return 'WEBUI';
      if (match === 'Api') return 'Webui';
      return 'webui';
    });
  }

  if (newBase && newBase !== base) {
    const sisterPath = path.join(dir, newBase + ext);
    if (fs.existsSync(sisterPath)) {
      return sisterPath;
    }
  }
  return null;
}

// IPC handlers for local files and workflows
ipcMain.handle('select-workflow-file', async () => {
  const defaultPath = path.join(app.getAppPath(), 'workflow');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select ComfyUI Workflow JSON File',
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
    const response = {
      fileName: path.basename(filePath),
      filePath: filePath,
      content: JSON.parse(fileContent)
    };

    // Try to auto-detect and read sister file
    try {
      const sisterPath = getSisterFilePath(filePath);
      if (sisterPath) {
        const sisterContent = fs.readFileSync(sisterPath, 'utf-8');
        response.sister = {
          fileName: path.basename(sisterPath),
          filePath: sisterPath,
          content: JSON.parse(sisterContent)
        };
      }
    } catch (sisterErr) {
      console.error('Failed to read or parse sister workflow JSON:', sisterErr);
    }

    return response;
  } catch (err) {
    throw new Error('Failed to read or parse workflow JSON: ' + err.message);
  }
});

// Select destination path to save the combined workflow JSON file
ipcMain.handle('select-save-workflow-file', async (event, defaultPath) => {
  const defaultDir = defaultPath && fs.existsSync(path.dirname(defaultPath))
    ? path.dirname(defaultPath)
    : path.join(app.getAppPath(), 'workflow');
  const defaultName = defaultPath ? path.basename(defaultPath) : 'combined_workflow.json';
  
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Combined Workflow JSON File',
    defaultPath: path.join(defaultDir, defaultName),
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
});

// Validate and merge WebUI and API workflows into a single listener combined JSON file
ipcMain.handle('combine-workflows', async (event, { webuiPath, apiPath, outputPath }) => {
  try {
    if (!webuiPath || !fs.existsSync(webuiPath)) {
      return { ok: false, error: 'WebUI workflow file path is invalid or does not exist.' };
    }
    if (!apiPath || !fs.existsSync(apiPath)) {
      return { ok: false, error: 'API workflow file path is invalid or does not exist.' };
    }
    if (!outputPath) {
      return { ok: false, error: 'Output path is not specified.' };
    }

    const webuiContent = fs.readFileSync(webuiPath, 'utf8');
    const apiContent = fs.readFileSync(apiPath, 'utf8');

    let webuiJson, apiJson;
    try {
      webuiJson = JSON.parse(webuiContent);
    } catch (e) {
      return { ok: false, error: 'Failed to parse WebUI workflow file as JSON.' };
    }

    try {
      apiJson = JSON.parse(apiContent);
    } catch (e) {
      return { ok: false, error: 'Failed to parse API workflow file as JSON.' };
    }

    // Validate ComfyUI format structures
    if (!webuiJson.nodes || !Array.isArray(webuiJson.nodes)) {
      return { ok: false, error: 'Selected WebUI file lacks a "nodes" list. Is it in WebUI format?' };
    }

    const apiKeys = Object.keys(apiJson);
    const numericKeys = apiKeys.filter(k => !isNaN(parseInt(k)));
    if (numericKeys.length === 0) {
      return { ok: false, error: 'Selected API file lacks numeric node IDs. Is it in API format?' };
    }

    const combined = {
      type: 'comfyui_listener_combined',
      version: '1.0',
      timestamp: new Date().toISOString(),
      webui: webuiJson,
      api: apiJson
    };

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(combined, null, 2), 'utf8');
    return { ok: true, filePath: outputPath, fileName: path.basename(outputPath), content: combined };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// Select an image file for LoadImage node
ipcMain.handle('select-image-file', async (event, defaultPath) => {
  const options = {
    title: 'Select Image File',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
    ],
    properties: ['openFile']
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  return {
    filePath: filePath,
    fileName: path.basename(filePath)
  };
});

// Select a target media file (image or video) for Facefusion
ipcMain.handle('select-ff-target-file', async (event, defaultPath) => {
  const options = {
    title: 'Select Target Image or Video File',
    filters: [
      { name: 'Media Files (Images & Videos)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp4', 'avi', 'mkv', 'mov', 'webm'] }
    ],
    properties: ['openFile']
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  return {
    filePath: filePath,
    fileName: path.basename(filePath)
  };
});

// Select Python executable file
ipcMain.handle('select-python-exe', async (event, defaultPath) => {
  const options = {
    title: 'Select Python Executable (python.exe)',
    filters: [
      { name: 'Python Executable (python.exe)', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Select Conda executable file
ipcMain.handle('select-conda-exe', async (event, defaultPath) => {
  const options = {
    title: 'Select Conda Executable (conda.exe)',
    filters: [
      { name: 'Conda Executable (conda.exe)', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Upload image to ComfyUI via HTTP API /upload/image
// For PNG files, injects the original absolute path as an iTXt metadata chunk
// (key: 'source_absolute_path') before uploading so the app can later recover
// the source location even when the workflow only stores the filename.
ipcMain.handle('upload-image-to-comfyui', async (event, { filePath, comfyUrl }) => {
  try {
    let fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.bmp') mimeType = 'image/bmp';

    // Inject source path into PNG metadata so the app can recover it later
    if (ext === '.png') {
      fileBuffer = injectPngMetadata(fileBuffer, { source_absolute_path: filePath });
    }

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

// Extract the 'source_absolute_path' iTXt chunk that was injected during upload.
// Fetches the image from ComfyUI (/view?filename=...&type=input) and reads its metadata.
// Returns { ok: true, sourcePath: '<absolute path>' } or { ok: false }.
ipcMain.handle('extract-png-source-path', async (event, { filename, comfyUrl }) => {
  try {
    if (!filename || !comfyUrl) return { ok: false };
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.png') return { ok: false }; // only PNG carries iTXt

    const url = `${comfyUrl}/view?filename=${encodeURIComponent(filename)}&type=input`;
    const response = await fetch(url);
    if (!response.ok) return { ok: false };

    const buffer = Buffer.from(await response.arrayBuffer());
    const chunks = extractPngTextChunks(buffer);
    const sourcePath = chunks['source_absolute_path'] || null;
    if (sourcePath) {
      return { ok: true, sourcePath };
    }
    return { ok: false };
  } catch (_) {
    return { ok: false };
  }
});

// Inject metadata directly into a local file in place
ipcMain.handle('inject-metadata-to-file', async (event, { filePath, metadata }) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `File does not exist: ${filePath}` };
    }
    let fileBuffer = fs.readFileSync(filePath);
    fileBuffer = injectPngMetadata(fileBuffer, metadata);
    fs.writeFileSync(filePath, fileBuffer);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Select output folder for saving generated images
ipcMain.handle('select-output-folder', async (event, defaultPath) => {
  const options = {
    title: 'Select Folder to Auto-Save Generated Images',
    properties: ['openDirectory', 'createDirectory']
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);

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
    if (!filename) return false;
    const targetPath = folderPath ? path.join(folderPath, filename) : filename;
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

// ─── Face Fusion Standalone Subprocess Control ───────────────────────────────
let activeFacefusionProcess = null;

ipcMain.handle('run-facefusion', async (event, { envType, condaEnvName, condaPath, facefusionPath, pythonPath, sourcePath, targetPath, outputPath, processors, executionProviders, faceSwapperModel, faceSwapperPixelBoost, faceSwapperWeight, faceSelectorMode, faceSelectorOrder }) => {
  if (activeFacefusionProcess) {
    return { ok: false, error: 'A Facefusion process is already running.' };
  }

  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      
      const useShell = (envType === 'conda');
      const quoteArg = (arg) => {
        if (!useShell) return arg;
        if (typeof arg !== 'string') return arg;
        if (arg.startsWith('"') && arg.endsWith('"')) return arg;
        if (/[ &`()^#;|[\]]/.test(arg) || arg.includes(' ')) {
          return `"${arg}"`;
        }
        return arg;
      };

      let command = 'python';
      let args = [];

      if (envType === 'conda') {
        command = condaPath || 'conda';
        if (useShell && command.includes(' ') && !command.startsWith('"')) {
          command = `"${command}"`;
        }
        args = [
          'run',
          '-n', condaEnvName || 'facefusion',
          'python',
          'facefusion.py',
          'headless-run',
          '--source-paths', quoteArg(sourcePath),
          '--target-path', quoteArg(targetPath),
          '--output-path', quoteArg(outputPath)
        ];
      } else {
        command = pythonPath || 'python';
        if (useShell && command.includes(' ') && !command.startsWith('"')) {
          command = `"${command}"`;
        }
        args = [
          'facefusion.py',
          'headless-run',
          '--source-paths', quoteArg(sourcePath),
          '--target-path', quoteArg(targetPath),
          '--output-path', quoteArg(outputPath)
        ];
      }

      if (processors && processors.length > 0) {
        args.push('--processors');
        args.push(...processors.map(quoteArg));
      }

      if (executionProviders && executionProviders.length > 0) {
        args.push('--execution-providers');
        args.push(...executionProviders.map(quoteArg));
      }

      if (faceSwapperModel) {
        args.push('--face-swapper-model', quoteArg(faceSwapperModel));
      }
      if (faceSwapperPixelBoost) {
        args.push('--face-swapper-pixel-boost', quoteArg(faceSwapperPixelBoost));
      }
      if (faceSwapperWeight !== undefined && faceSwapperWeight !== null && faceSwapperWeight !== '') {
        args.push('--face-swapper-weight', quoteArg(String(faceSwapperWeight)));
      }
      if (faceSelectorMode) {
        args.push('--face-selector-mode', quoteArg(faceSelectorMode));
      }
      if (faceSelectorOrder) {
        args.push('--face-selector-order', quoteArg(faceSelectorOrder));
      }

      const spawnOptions = {
        cwd: facefusionPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }, // ensure logs are flushed immediately
        shell: useShell
      };

      // Log start command
      const displayCommand = command.startsWith('"') ? command : `"${command}"`;
      const cmdString = envType === 'conda'
        ? `${displayCommand} run -n ${condaEnvName || 'facefusion'} python facefusion.py ${args.slice(5).join(' ')}`
        : `${displayCommand} ${args.join(' ')}`;
      event.sender.send('facefusion-log', { type: 'system', text: `Running command in ${facefusionPath} (env: ${envType}):\n${cmdString}\n` });

      activeFacefusionProcess = spawn(command, args, spawnOptions);

      activeFacefusionProcess.stdout.on('data', (data) => {
        const text = data.toString();
        event.sender.send('facefusion-log', { type: 'stdout', text });

        // Parse progress if possible (e.g. "Processing: 45%" or "45%")
        const progressMatch = text.match(/Processing:\s*(\d+)%/i) || text.match(/(\d+)%/);
        if (progressMatch) {
          const percent = parseInt(progressMatch[1], 10);
          event.sender.send('facefusion-progress', { percent });
        }
      });

      activeFacefusionProcess.stderr.on('data', (data) => {
        const text = data.toString();
        event.sender.send('facefusion-log', { type: 'stderr', text });
        
        // Some libraries print progress on stderr
        const progressMatch = text.match(/Processing:\s*(\d+)%/i) || text.match(/(\d+)%/);
        if (progressMatch) {
          const percent = parseInt(progressMatch[1], 10);
          event.sender.send('facefusion-progress', { percent });
        }
      });

      activeFacefusionProcess.on('close', (code) => {
        activeFacefusionProcess = null;
        event.sender.send('facefusion-log', { type: 'system', text: `\nProcess finished with exit code ${code}\n` });
        
        if (code === 0) {
          try {
            const targetExt = path.extname(targetPath).toLowerCase();
            const outputExt = path.extname(outputPath).toLowerCase();
            if (targetExt === '.png' && outputExt === '.png' && fs.existsSync(targetPath) && fs.existsSync(outputPath)) {
              const targetBuf = fs.readFileSync(targetPath);
              const targetMetadata = extractPngTextChunks(targetBuf);
              if (targetMetadata && Object.keys(targetMetadata).length > 0) {
                const outputBuf = fs.readFileSync(outputPath);
                const updatedBuf = injectPngMetadata(outputBuf, targetMetadata);
                fs.writeFileSync(outputPath, updatedBuf);
                event.sender.send('facefusion-log', { 
                  type: 'system', 
                  text: `Successfully injected ComfyUI workflow metadata from target image into face fusion output PNG.\n` 
                });
              }
            }
          } catch (metaErr) {
            console.error('Failed to inject metadata from target image:', metaErr);
            event.sender.send('facefusion-log', { 
              type: 'system', 
              text: `Warning: Failed to inject workflow metadata: ${metaErr.message}\n` 
            });
          }
        }
        
        resolve({ ok: code === 0, code });
      });

      activeFacefusionProcess.on('error', (err) => {
        activeFacefusionProcess = null;
        event.sender.send('facefusion-log', { type: 'error', text: `\nProcess error: ${err.message}\n` });
        resolve({ ok: false, error: err.message });
      });

    } catch (err) {
      activeFacefusionProcess = null;
      resolve({ ok: false, error: err.message });
    }
  });
});

ipcMain.handle('stop-facefusion', async () => {
  if (activeFacefusionProcess) {
    try {
      const pid = activeFacefusionProcess.pid;
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec(`taskkill /F /T /PID ${pid}`);
      } else {
        activeFacefusionProcess.kill('SIGINT');
        const proc = activeFacefusionProcess;
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
        }, 1000);
      }
      activeFacefusionProcess = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'No process is currently running.' };
});

// Import prompts and images from ComfyUI generated PNG or JSON workflow
ipcMain.handle('import-prompt-file', async (event, defaultPath) => {
  const options = {
    title: 'Select ComfyUI Generated Image or JSON Workflow',
    filters: [
      { name: 'ComfyUI Files (PNG Images, JSON Workflows)', extensions: ['png', 'json'] }
    ],
    properties: ['openFile']
  };

  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }

  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  try {
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.json') {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate ComfyUI JSON format
      const keys = Object.keys(parsed);
      const hasNumericKeys = keys.some(k => !isNaN(parseInt(k)));
      const isWebUiFormat = Array.isArray(parsed.nodes);
      
      if (!hasNumericKeys && !isWebUiFormat) {
        return { ok: false, error: 'This file does not contain the required data to be extracted.' };
      }
      return { ok: true, type: 'json', content: parsed, filePath: filePath };
    } else if (ext === '.png') {
      const fileBuffer = fs.readFileSync(filePath);
      const textChunks = extractPngTextChunks(fileBuffer);
      // Also extract our injected output settings, if present
      let outputSettings = null;
      if (textChunks && textChunks.output_settings) {
        try { outputSettings = JSON.parse(textChunks.output_settings); } catch (_) {}
      }
      if (textChunks && textChunks.prompt) {
        const parsed = JSON.parse(textChunks.prompt);
        return { ok: true, type: 'png_prompt', content: parsed, filePath: filePath, outputSettings };
      } else if (textChunks && textChunks.workflow) {
        const parsed = JSON.parse(textChunks.workflow);
        return { ok: true, type: 'png_workflow', content: parsed, filePath: filePath, outputSettings };
      } else {
        return { ok: false, error: 'No workflow metadata found in this PNG file.' };
      }
    }
    return { ok: false, error: 'Unsupported file type.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── Folder Watching for Automation ──────────────────────────────────────────
let activeWatcher = null;
let watchedDir = null;
const existingFiles = new Set();
const fileTimeouts = new Map();

function stopWatching() {
  if (activeWatcher) {
    activeWatcher.close();
    activeWatcher = null;
  }
  watchedDir = null;
  existingFiles.clear();
  for (const timeout of fileTimeouts.values()) {
    clearTimeout(timeout);
  }
  fileTimeouts.clear();
}

ipcMain.handle('start-watching-folder', async (event, folderPath) => {
  stopWatching();
  
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { ok: false, error: 'Folder does not exist' };
  }

  try {
    watchedDir = folderPath;
    
    // Scan existing files so we only trigger on newly added files
    const files = fs.readdirSync(folderPath);
    for (const f of files) {
      existingFiles.add(path.join(folderPath, f).toLowerCase());
    }

    activeWatcher = fs.watch(folderPath, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(folderPath, filename);
      const fullPathLower = fullPath.toLowerCase();

      // Check if it's a supported image file extension
      const ext = path.extname(filename).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
        return;
      }

      if (existingFiles.has(fullPathLower)) {
        return;
      }

      // Debounce events to allow file writing to finish
      if (fileTimeouts.has(fullPathLower)) {
        clearTimeout(fileTimeouts.get(fullPathLower));
      }

      const timeout = setTimeout(() => {
        fileTimeouts.delete(fullPathLower);
        try {
          if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            if (stats.isFile() && stats.size > 0) {
              existingFiles.add(fullPathLower);
              if (mainWindow) {
                mainWindow.webContents.send('watch-folder-new-image', {
                  filePath: fullPath,
                  fileName: filename
                });
              }
            }
          }
        } catch (err) {
          // File might still be locked or busy, ignore this event
        }
      }, 500);

      fileTimeouts.set(fullPathLower, timeout);
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-watching-folder', async () => {
  stopWatching();
  return { ok: true };
});



