const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: true,
      contextIsolation: true
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

const fs = require('node:fs');
const { dialog } = require('electron');

// Ler o PDF como array de bytes (Uint8Array) para carregar no PDF.js com segurança no Electron.
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    return { success: true, base64: data.toString('base64'), name: path.basename(filePath) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Nova rota IPC para acionar a janela de Abrir Arquivo do SO
ipcMain.handle('open-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }]
  });

  if (canceled || filePaths.length === 0) {
    return { success: false };
  }

  const filePath = filePaths[0];
  try {
    const data = fs.readFileSync(filePath);
    return { success: true, base64: data.toString('base64'), name: path.basename(filePath), path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

const pkcs11Service = require('./src/backend/pkcs11Service.cjs');
const pdfSignService = require('./src/backend/pdfSignService.cjs');

ipcMain.handle('get-certificates', async () => {
  return pkcs11Service.getCertificates();
});

ipcMain.handle('sign-pdf', async (event, args) => {
  try {
    console.log("Recebido pedido de assinatura. Slot:", args.slotId);

    // Verifica se veio um buffer da RAM ou se devemos puxar do disco físico.
    let pdfBuffer = null;
    if (args.fileData) {
      pdfBuffer = Buffer.from(args.fileData);
    } else if (args.filePath) {
      pdfBuffer = fs.readFileSync(args.filePath);
    } else {
      throw new Error("Nenhum arquivo enviado (nenhum Path nem DataBuffer).");
    }

    // Chamada atualizada com o Array chainB64, a BoundingBox Visual desenhada no React, e o Ícone
    const signResult = await pdfSignService.signBuffer(pdfBuffer, args.slotId, args.keyId, args.certDerBase64, args.chainB64, args.signatureBox, args.iconName);

    if (signResult.success) {
      let defaultName = 'documento_assinado_tb.pdf';
      let basePath = '';
      if (args.filePath) {
        const parsedPath = path.parse(args.filePath);
        defaultName = `${parsedPath.name}_tb${parsedPath.ext}`;
        basePath = parsedPath.dir;
      } else if (args.originalName) {
        defaultName = args.originalName.replace(/\.pdf$/i, '_tb.pdf');
      }

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Salvar PDF Assinado',
        defaultPath: basePath ? path.join(basePath, defaultName) : defaultName,
        filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }]
      });

      if (canceled || !filePath) return { success: false, error: 'Salvamento cancelado pelo usuário.' };
      const destPath = filePath;

      fs.writeFileSync(destPath, signResult.signedBuffer);
      return { success: true, destPath: destPath };
    } else {
      return signResult;
    }
  } catch (e) {
    console.error("Erro fatal na IPC sign-pdf:", e);
    return { success: false, error: e.message };
  }
});
