/**
 * Easel — main process entry point.
 *
 * Boots the Electron app: single-instance lock, settings init, IPC handler
 * registration, and the main window. macOS-aware lifecycle.
 */
import { app, BrowserWindow } from 'electron';
import { createMainWindow, getMainWindow } from '@main/window';
import { registerIpcHandlers } from '@main/ipc';
import { initSettings } from '@main/settings';
import { stopDevServer } from '@main/devServer';
import { disposeNetworkTap } from '@main/networkTap';
import { disposePuppeteer } from '@main/puppeteer';
import { rootLogger } from '@main/logger';

const log = rootLogger;

// Single-instance lock: focus the existing window if a second instance launches.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    log.info('App ready — initializing Easel');
    try {
      initSettings();
      registerIpcHandlers();
    } catch (err) {
      log.error('Initialization failed', { err: String(err) });
    }
    createMainWindow();

    app.on('activate', () => {
      // macOS: re-create a window when the dock icon is clicked and none are open.
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Quit on all platforms except macOS, where apps stay active until Cmd+Q.
    if (process.platform !== 'darwin') app.quit();
  });

  // Never leave a dev server we started orphaned, or a CDP debugger attached to
  // the preview, when Easel exits.
  app.on('before-quit', () => {
    stopDevServer();
    disposeNetworkTap();
    disposePuppeteer();
  });
}
