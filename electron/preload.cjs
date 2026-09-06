'use strict';

/**
 * The only surface the renderer sees.
 *
 * Nothing from Node leaks past this file: each method is a named channel
 * with a fixed shape, and menu/event callbacks are wrapped so the renderer
 * receives plain values rather than Electron's event object.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main-process event, returning an unsubscribe function. */
function on(channel, listener) {
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('phototrack', {
  platform: process.platform,

  /* project files (binary — a .phototrack is a zip) */
  save: (bytes, suggestedName, forceDialog) =>
    ipcRenderer.invoke('project:save', bytes, suggestedName, Boolean(forceDialog)),
  openProject: () => ipcRenderer.invoke('project:openDialog'),
  exportDelta: (bytes, suggestedName) => ipcRenderer.invoke('delta:export', bytes, suggestedName),
  importDelta: () => ipcRenderer.invoke('delta:import'),
  exportPdf: (suggestedName) => ipcRenderer.invoke('sheets:exportPdf', suggestedName),
  print: () => ipcRenderer.invoke('project:print'),
  setDirty: (dirty) => ipcRenderer.send('state:dirty', dirty),

  /* crash recovery */
  writeRecovery: (bytes) => ipcRenderer.invoke('recovery:write', bytes),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
  promptRecovery: (when) => ipcRenderer.invoke('recovery:prompt', when),

  /* menu commands */
  onNew: (fn) => on('menu:new', fn),
  onSave: (fn) => on('menu:save', fn),
  onSaveAs: (fn) => on('menu:saveAs', fn),
  onPrint: (fn) => on('menu:print', fn),
  onUndo: (fn) => on('menu:undo', fn),
  onRedo: (fn) => on('menu:redo', fn),
  onFileOpened: (fn) => on('file:opened', fn),
  onPathChanged: (fn) => on('file:pathChanged', fn),

  /* WoodWing Elvis sync — see electron/main.cjs for why this runs here */
  elvisGetConfig: () => ipcRenderer.invoke('elvis:getConfig'),
  elvisSetConfig: (config) => ipcRenderer.invoke('elvis:setConfig', config),
  elvisSearch: (config) => ipcRenderer.invoke('elvis:search', config),
  elvisUpdate: (config, assetId, metadata) => ipcRenderer.invoke('elvis:update', config, assetId, metadata),
});
