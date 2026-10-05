'use strict';

/**
 * Electron main process.
 *
 * Everything here is something a page in a browser cannot do: a real menu
 * bar with system shortcuts, Save that writes back to the file you opened, a
 * Save As dialog, PDF written straight to a chosen path, an autosave on disk
 * that survives a crash, and — the reason any of this runs as a desktop app
 * at all — WoodWing Elvis requests, which have to originate here to get past
 * both the renderer's opaque `file://` origin and CORS on a real DAM server.
 *
 * The renderer never touches Node. Everything crosses the preload bridge as
 * plain values (strings, or `Uint8Array` for the zip-based project and delta
 * files), and the window stays sandboxed with context isolation on.
 *
 * Targets Electron 22 — the last major version with a macOS 10.13 (High
 * Sierra) build, alongside Apple Silicon via a universal binary. Electron 22
 * is past its own security-patch window; that is an accepted tradeoff for an
 * offline, internal production tool that has to run on both. Do not bump
 * past it without checking whether 10.13 support is still required.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createElvisClient } = require('./elvisClient.cjs');
const { electronTransport } = require('./elvisTransport.cjs');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
const DEV_SERVER = process.env.PHOTOTRACK_DEV_SERVER || 'http://localhost:5173';

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Path of the project currently open, so Save can write back to it. */
let currentPath = null;
/** Set from the renderer; gates the "unsaved changes" prompt on quit. */
let hasUnsavedChanges = false;
let quitting = false;

const RECOVERY_FILE = () => path.join(app.getPath('userData'), 'recovery.phototrack');
const ELVIS_CONFIG_FILE = () => path.join(app.getPath('userData'), 'elvis-config.json');

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#101215',
    title: 'PhotoTrack',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  loadApp();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (quitting || !hasUnsavedChanges) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Save…', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'You have unsaved changes.',
      detail: 'Save this project before closing?',
    });
    if (choice === 2) return;
    if (choice === 1) {
      hasUnsavedChanges = false;
      mainWindow.close();
      return;
    }
    send('menu:save');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  nativeTheme.themeSource = 'dark';
}

async function loadApp() {
  const built = path.join(__dirname, '..', 'dist', 'index.html');
  if (isDev) {
    try {
      await mainWindow.loadURL(DEV_SERVER);
      return;
    } catch {
      /* no dev server; fall through to the build */
    }
  }
  try {
    await mainWindow.loadFile(built);
  } catch (error) {
    dialog.showErrorBox(
      'PhotoTrack could not start',
      `The interface was not found at:\n${built}\n\nRun \`npm run build\` first.\n\n${error}`,
    );
  }
}

function send(channel, ...args) {
  mainWindow?.webContents.send(channel, ...args);
}

/* ------------------------------------------------------------------ *
 * Menu
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openProjectDialog() },
        {
          label: 'Open Recent',
          role: 'recentdocuments',
          submenu: [{ label: 'Clear Menu', role: 'clearrecentdocuments' }],
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('menu:saveAs') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('menu:print') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Project files (binary — a .phototrack is a zip, not JSON text)
 * ------------------------------------------------------------------ */

const PROJECT_FILTERS = [{ name: 'PhotoTrack Project', extensions: ['phototrack'] }];
const DELTA_FILTERS = [{ name: 'PhotoTrack Delta', extensions: ['ptdelta'] }];

function noteOpened(filePath) {
  currentPath = filePath;
  app.addRecentDocument(filePath);
  mainWindow?.setRepresentedFilename?.(filePath);
  mainWindow?.setTitle(`PhotoTrack — ${path.basename(filePath)}`);
  send('file:pathChanged', filePath);
}

/** Open a project by dialog, or by a path the OS handed us (double-click). */
async function openProjectDialog(filePath) {
  let target = filePath;
  if (!target) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Project',
      properties: ['openFile'],
      filters: PROJECT_FILTERS,
    });
    if (canceled || filePaths.length === 0) return;
    target = filePaths[0];
  }
  try {
    const buffer = await fs.readFile(target);
    noteOpened(target);
    send('file:opened', new Uint8Array(buffer), target);
  } catch (error) {
    dialog.showErrorBox('Could not open that project', String(error));
  }
}

ipcMain.handle('project:openDialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    properties: ['openFile'],
    filters: PROJECT_FILTERS,
  });
  if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const buffer = await fs.readFile(filePaths[0]);
    noteOpened(filePaths[0]);
    return { ok: true, path: filePaths[0], bytes: new Uint8Array(buffer) };
  } catch (error) {
    dialog.showErrorBox('Could not open that project', String(error));
    return { ok: false };
  }
});

ipcMain.handle('project:save', async (_event, bytes, suggestedName, forceDialog) => {
  let target = forceDialog ? null : currentPath;
  if (!target) {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Project',
      defaultPath: currentPath ?? suggestedName,
      filters: PROJECT_FILTERS,
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    target = filePath;
  }
  try {
    await fs.writeFile(target, Buffer.from(bytes));
    noteOpened(target);
    hasUnsavedChanges = false;
    return { ok: true, path: target };
  } catch (error) {
    dialog.showErrorBox('Could not save that project', String(error));
    return { ok: false };
  }
});

ipcMain.handle('delta:export', async (_event, bytes, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Delta',
    defaultPath: suggestedName,
    filters: DELTA_FILTERS,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.writeFile(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (error) {
    dialog.showErrorBox('Could not export the delta file', String(error));
    return { ok: false };
  }
});

ipcMain.handle('delta:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Delta',
    properties: ['openFile'],
    filters: DELTA_FILTERS,
  });
  if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const buffer = await fs.readFile(filePaths[0]);
    return { ok: true, path: filePaths[0], bytes: new Uint8Array(buffer) };
  } catch (error) {
    dialog.showErrorBox('Could not read that delta file', String(error));
    return { ok: false };
  }
});

ipcMain.handle('sheets:exportPdf', async (event, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export as PDF',
    defaultPath: `${suggestedName}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const pdf = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    });
    await fs.writeFile(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (error) {
    dialog.showErrorBox('Could not export the PDF', String(error));
    return { ok: false };
  }
});

ipcMain.handle('project:print', async (event) => {
  event.sender.print({ printBackground: true }, () => {});
  return { ok: true };
});

ipcMain.on('state:dirty', (_event, dirty) => {
  hasUnsavedChanges = Boolean(dirty);
  mainWindow?.setDocumentEdited?.(hasUnsavedChanges);
});

/* --- autosave / crash recovery ------------------------------------- */

ipcMain.handle('recovery:write', async (_event, bytes) => {
  try {
    await fs.writeFile(RECOVERY_FILE(), Buffer.from(bytes));
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('recovery:read', async () => {
  try {
    const buffer = await fs.readFile(RECOVERY_FILE());
    return { ok: true, bytes: new Uint8Array(buffer) };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('recovery:clear', async () => {
  try {
    await fs.unlink(RECOVERY_FILE());
  } catch {
    /* nothing to clear */
  }
  return { ok: true };
});

ipcMain.handle('recovery:prompt', async (_event, when) => {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['Restore', 'Discard'],
    defaultId: 0,
    cancelId: 1,
    message: 'PhotoTrack closed unexpectedly.',
    detail: `There are unsaved changes from ${when}. Restore them?`,
  });
  return { restore: choice === 0 };
});

/* ------------------------------------------------------------------ *
 * WoodWing Elvis sync
 *
 * Config (including any API key or password) is encrypted at rest with
 * Electron's `safeStorage`, which uses the OS keychain on macOS. It is
 * stored once here and never written into a project file, a recovery file,
 * or a delta — those all come from the renderer, which never holds this
 * config beyond what's needed to render the settings panel.
 * ------------------------------------------------------------------ */

async function readElvisConfig() {
  try {
    const raw = await fs.readFile(ELVIS_CONFIG_FILE());
    if (safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(raw));
    }
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

async function writeElvisConfig(config) {
  const json = JSON.stringify(config);
  const payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  await fs.writeFile(ELVIS_CONFIG_FILE(), payload);
}

// The renderer normalises whatever is stored (src/lib/elvis/types.ts,
// `normalizeElvisConfig`), so an empty object is a valid "not set up yet".
const DEFAULT_ELVIS_CONFIG = {};

ipcMain.handle('elvis:getConfig', async () => {
  return (await readElvisConfig()) ?? DEFAULT_ELVIS_CONFIG;
});

ipcMain.handle('elvis:setConfig', async (_event, config) => {
  try {
    await writeElvisConfig(config);
    elvis.forget();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

// One client for the app's lifetime, so a login is reused across calls
// rather than consuming a fresh Elvis API licence for every request.
const elvis = createElvisClient(electronTransport);

ipcMain.handle('elvis:test', async (_event, config) => elvis.test(config));
ipcMain.handle('elvis:search', async (_event, config) => elvis.search(config));
ipcMain.handle('elvis:update', async (_event, config, assetId, metadata) => elvis.update(config, assetId, metadata));
ipcMain.handle('elvis:fetchImage', async (_event, config, url) => elvis.fetchImage(config, url));
ipcMain.handle('elvis:findFile', async (_event, config, assetPath) => elvis.findFile(config, assetPath));
ipcMain.handle('elvis:download', async (_event, config, url) => elvis.download(config, url));
ipcMain.handle('elvis:upload', async (_event, config, file) => elvis.upload(config, file));

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

const pendingOpen = [];
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) openProjectDialog(filePath);
  else pendingOpen.push(filePath);
});

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  if (pendingOpen.length > 0) {
    mainWindow?.webContents.once('did-finish-load', () => openProjectDialog(pendingOpen.shift()));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
