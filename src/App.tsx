import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Settings,
  User,
  ListPlus,
  FileSignature,
  Image,
  RefreshCw,
  QrCode,
  FolderOpen,
  Upload,
  CheckCircle2,
  Smartphone,
} from 'lucide-react';
import PdfViewer from './components/PdfViewer';
import {
  platformBridge,
  type Certificate,
  type SerproIdStatus,
} from './services/platformBridge';

declare global {
  interface Window {
    electronAPI?: {
      openFileDialog: () => Promise<{
        success: boolean;
        base64?: string;
        name?: string;
        path?: string;
      }>;
      getCertificates: () => Promise<{
        success: boolean;
        certs?: Certificate[];
        error?: string;
      }>;
      signPdf: (opts: {
        fileData?: Uint8Array;
        filePath?: string;
        originalName?: string;
        slotId: string;
        keyId: string;
        certDerBase64: string;
        chainB64: string[];
        signatureBox?: {
          page: number;
          x: number;
          y: number;
          w: number;
          h: number;
        } | null;
        iconName?: string;
      }) => Promise<{ success: boolean; destPath?: string; error?: string }>;
      readFile: (path: string) => Promise<{
        success: boolean;
        base64?: string;
        name?: string;
        path?: string;
      }>;
    };
  }
}

type Tab = {
  id: string;
  name: string;
  filePath: string;
  fileData: Uint8Array;
  path?: string;
};

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [selectedCertIndex, setSelectedCertIndex] = useState<number>(0);
  const [signatureBox, setSignatureBox] = useState<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showCertModal, setShowCertModal] = useState(false);
  const [isLoadingCerts, setIsLoadingCerts] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showIconModal, setShowIconModal] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState('ipe.png');

  // Estados de pareamento e sincronização do SerproID no Ubuntu Touch
  const [serproStatus, setSerproStatus] = useState<SerproIdStatus | null>(null);
  const [showPairPanel, setShowPairPanel] = useState(false);
  const [showManualImport, setShowManualImport] = useState(false);
  const [manualMaquinaId, setManualMaquinaId] = useState('');
  const [manualCertId, setManualCertId] = useState('');
  const [manualCertPem, setManualCertPem] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const certFileInputRef = useRef<HTMLInputElement>(null);

  const checkPendingContentHubFiles = useCallback(async () => {
    const imported = await platformBridge.fetchPendingContentHubFiles();
    if (imported.length > 0) {
      const newTabs: Tab[] = imported.map((item) => ({
        id: `tab-${Date.now()}-${Math.random()}`,
        name: item.name,
        filePath: item.path,
        fileData: item.fileData,
      }));
      setTabs((prev) => {
        const updated = [...prev, ...newTabs];
        setActiveTabId(updated[updated.length - 1].id);
        return updated;
      });
    }
  }, []);

  useEffect(() => {
    checkPendingContentHubFiles();
    const handler = () => {
      checkPendingContentHubFiles();
    };
    window.addEventListener('ut-check-pending-files', handler);
    return () => window.removeEventListener('ut-check-pending-files', handler);
  }, [checkPendingContentHubFiles]);

  const openCertModalAndLoad = async () => {
    setShowCertModal(true);
    setIsLoadingCerts(true);
    setStatusMessage(null);

    const status = await platformBridge.getSerproIdStatus();
    setSerproStatus(status);
    if (status.maquinaId) {
      setManualMaquinaId(status.maquinaId);
    }

    const res = await platformBridge.getCertificates();
    if (res.success && res.certs) {
      setCertificates(res.certs);
      if (res.certs.length > 0) {
        setSelectedCertIndex(0);
      }
    } else if (res.error) {
      console.error(res.error);
      setStatusMessage('Aviso: ' + res.error);
    }
    setIsLoadingCerts(false);
  };

  const handlePairDevice = async () => {
    setIsLoadingCerts(true);
    setStatusMessage('Registrando dispositivo junto ao SerproID...');
    const res = await platformBridge.pairSerproIdDevice();
    if (res.success) {
      setSerproStatus(res);
      if (res.maquinaId) setManualMaquinaId(res.maquinaId);
      setShowPairPanel(true);
      setStatusMessage(
        'Identificador gerado! Associe no app SerproID e toque em Sincronizar Certificados.'
      );
    } else {
      setStatusMessage('Erro ao parear com SerproID: ' + res.error);
    }
    setIsLoadingCerts(false);
  };

  const handleSyncCertificates = async () => {
    setIsLoadingCerts(true);
    setStatusMessage('Sincronizando certificados com a nuvem SerproID...');
    const res = await platformBridge.syncSerproIdCertificates();
    if (res.success && res.certs) {
      setCertificates(res.certs);
      setShowPairPanel(false);
      setStatusMessage(
        `${res.certs.length} certificado(s) sincronizado(s) com sucesso!`
      );
    } else {
      setStatusMessage(res.error || 'Falha ao sincronizar certificados.');
    }
    setIsLoadingCerts(false);
  };

  const handleSaveManualImport = async () => {
    setIsLoadingCerts(true);
    const res = await platformBridge.importManualSerproId({
      maquinaId: manualMaquinaId,
      certId: manualCertId,
      certData: manualCertPem,
    });
    if (res.success && res.certs) {
      setCertificates(res.certs);
      setShowManualImport(false);
      setStatusMessage('Credenciais SerproID atualizadas com sucesso!');
    } else {
      setStatusMessage(res.error || 'Erro ao importar credenciais.');
    }
    setIsLoadingCerts(false);
  };

  const handleCertFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const stem = file.name.replace(/\.(cer|crt|pem|der)$/i, '');
    if (/^\d+$/.test(stem) && !manualCertId) {
      setManualCertId(stem);
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    setManualCertPem(window.btoa(binary));
  };

  const openPdfDocument = async () => {
    if (platformBridge.isElectron() && window.electronAPI) {
      try {
        const response = await window.electronAPI.openFileDialog();
        if (response.success && response.base64) {
          const byteCharacters = atob(response.base64);
          const byteArray = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
          }
          const newTabId = `tab-${Date.now()}`;
          setTabs((prev) => [
            ...prev,
            {
              id: newTabId,
              name: response.name || 'documento.pdf',
              filePath: response.path || '',
              fileData: byteArray,
            },
          ]);
          setActiveTabId(newTabId);
          return;
        }
      } catch (error) {
        console.error('Erro ao abrir arquivo via Electron:', error);
      }
    }

    // No Ubuntu Touch, aciona o Lomiri Content Hub e também permite fallback HTML5 file input
    const hubTriggered = await platformBridge.requestContentHubImport();
    if (!hubTriggered && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleHtmlFileInput = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newTabs: Tab[] = [];
    for (const file of Array.from(files)) {
      const arrayBuffer = await file.arrayBuffer();
      const byteArray = new Uint8Array(arrayBuffer);
      newTabs.push({
        id: `tab-${Date.now()}-${Math.random()}`,
        name: file.name,
        filePath: '',
        fileData: byteArray,
      });
    }

    if (newTabs.length > 0) {
      setTabs((prev) => {
        const updated = [...prev, ...newTabs];
        setActiveTabId(updated[updated.length - 1].id);
        return updated;
      });
    }
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files).filter(
        (f) =>
          f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );

      if (filesArray.length === 0) return;

      const newTabs: Tab[] = [];

      for (const file of filesArray) {
        const filePath = (file as unknown as { path?: string }).path;
        if (filePath) {
          try {
            const response = await platformBridge.readFile(filePath);
            if (response.success && response.base64) {
              const byteCharacters = atob(response.base64);
              const byteArray = new Uint8Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteArray[i] = byteCharacters.charCodeAt(i);
              }
              newTabs.push({
                id: `tab-${Date.now()}-${Math.random()}`,
                name: response.name || file.name,
                filePath,
                fileData: byteArray,
              });
              continue;
            }
          } catch (err) {
            console.error('Erro na leitura de path nativo:', err);
          }
        }

        const arrayBuffer = await file.arrayBuffer();
        const byteArray = new Uint8Array(arrayBuffer);
        newTabs.push({
          id: `tab-${Date.now()}-${Math.random()}`,
          name: file.name,
          filePath: '',
          fileData: byteArray,
        });
      }

      if (newTabs.length > 0) {
        setTabs((prev) => {
          const updated = [...prev, ...newTabs];
          setActiveTabId(updated[updated.length - 1].id);
          return updated;
        });
      }
    }
  };

  return (
    <div
      className="flex flex-col sm:flex-row h-screen bg-gray-50 text-gray-900 overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Input oculto para fallback / seleção local de arquivos PDF */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={handleHtmlFileInput}
      />

      {/* Sidebar Lateral (Desktop / Convergência Ubuntu Touch) */}
      <div className="hidden sm:flex w-16 bg-white border-r border-gray-200 flex-col items-center py-4 justify-between shadow-sm z-40">
        <div className="flex flex-col gap-4 w-full px-2">
          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={openPdfDocument}
            title="Abrir Documento PDF (Content Hub)"
          >
            <ListPlus size={24} />
          </button>

          <button
            className="group relative p-3 w-full flex justify-center text-gray-600 hover:bg-gray-100 rounded-xl transition"
            onClick={() => fileInputRef.current?.click()}
            title="Selecionar PDF do Armazenamento Local"
          >
            <FolderOpen size={22} />
          </button>
        </div>

        <div className="flex flex-col gap-6 w-full px-2">
          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={() => setShowIconModal(true)}
            title="Escolher Ícone de Assinatura"
          >
            <Image size={24} />
          </button>

          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={openCertModalAndLoad}
            title="Certificados (SerproID)"
          >
            <User size={24} />
          </button>

          <button
            className="group relative p-3 w-full flex justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition"
            onClick={() => setShowAboutModal(true)}
            title="Sobre o Assinei!"
          >
            <Settings size={24} />
          </button>
        </div>
      </div>

      {/* Conteúdo Principal */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Barra de Abas (Top) */}
        <div className="bg-gray-100 flex items-center px-2 pt-2 gap-1 overflow-x-auto shadow-inner border-b border-gray-200 shrink-0">
          {tabs.length === 0 ? (
            <div className="px-3 py-2 text-xs sm:text-sm text-gray-500 italic">
              Nenhum documento aberto
            </div>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`min-w-28 max-w-56 flex items-center justify-between px-3 py-2 text-xs sm:text-sm rounded-t-lg border border-b-0 cursor-pointer transition ${
                  activeTabId === tab.id
                    ? 'bg-white border-gray-200 text-blue-700 font-medium z-10'
                    : 'bg-gray-50 border-transparent text-gray-500 hover:bg-gray-200'
                }`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span className="truncate">{tab.name}</span>
                <button
                  className="ml-2 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-300 text-gray-400 hover:text-gray-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    const newTabs = tabs.filter((t) => t.id !== tab.id);
                    setTabs(newTabs);
                    if (activeTabId === tab.id) {
                      setActiveTabId(
                        newTabs.length > 0
                          ? newTabs[newTabs.length - 1].id
                          : null
                      );
                    }
                  }}
                >
                  &times;
                </button>
              </div>
            ))
          )}
        </div>

        {/* Viewport do Documento */}
        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden relative bg-gray-200/50">
          {tabs.length === 0 || !activeTabId ? (
            <div className="text-center max-w-sm px-4">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 mb-4 inline-block w-full">
                <img
                  src="./ipe.png"
                  alt="Logomarca Assinei!"
                  className="mx-auto mb-3 h-16 object-contain"
                />
                <h2 className="text-xl font-semibold text-gray-800">
                  Assinei!
                </h2>
                <p className="text-xs font-medium text-blue-600 mt-0.5">
                  Ubuntu Touch Edition (ICP-Brasil / SerproID)
                </p>
                <p className="text-sm text-gray-500 mt-3">
                  Abra um documento PDF pelo Content Hub do Ubuntu Touch ou
                  selecione do seu aparelho.
                </p>

                <div className="mt-5 flex flex-col gap-2.5">
                  <button
                    onClick={openPdfDocument}
                    className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 shadow-sm transition"
                  >
                    <ListPlus size={18} />
                    Abrir via Content Hub
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition"
                  >
                    <FolderOpen size={16} />
                    Escolher Arquivo Local (.pdf)
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="w-full h-full relative">
              <PdfViewer
                fileData={tabs.find((t) => t.id === activeTabId)!.fileData}
                onSignatureChange={(page, x, y, w, h) =>
                  setSignatureBox({ page, x, y, w, h })
                }
              />

              {/* Botão Flutuante Assinar Agora */}
              <div className="absolute bottom-5 right-5 sm:bottom-8 sm:right-8 z-30 flex flex-col items-center">
                <button
                  title="Assinar Agora (SERPRO-ID)"
                  className="bg-blue-600 hover:bg-blue-700 text-white shadow-xl px-6 py-3 rounded-full font-medium flex items-center gap-2 transition transform active:scale-95 text-sm sm:text-base"
                  onClick={openCertModalAndLoad}
                >
                  <FileSignature size={20} />
                  Assinar Agora
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Barra de Navegação Inferior (Ubuntu Touch Mobile Portrait) */}
        <div className="flex sm:hidden h-14 bg-white border-t border-gray-200 items-center justify-around px-2 shadow-md z-40 shrink-0">
          <button
            className="flex flex-col items-center justify-center text-blue-600 py-1 px-3 rounded-lg active:bg-blue-50"
            onClick={openPdfDocument}
          >
            <ListPlus size={20} />
            <span className="text-[10px] font-medium mt-0.5">Abrir PDF</span>
          </button>

          <button
            className="flex flex-col items-center justify-center text-gray-600 py-1 px-3 rounded-lg active:bg-gray-100"
            onClick={() => fileInputRef.current?.click()}
          >
            <FolderOpen size={20} />
            <span className="text-[10px] font-medium mt-0.5">Local</span>
          </button>

          <button
            className="flex flex-col items-center justify-center text-blue-600 py-1 px-3 rounded-lg active:bg-blue-50"
            onClick={() => setShowIconModal(true)}
          >
            <Image size={20} />
            <span className="text-[10px] font-medium mt-0.5">Selo</span>
          </button>

          <button
            className="flex flex-col items-center justify-center text-blue-600 py-1 px-3 rounded-lg active:bg-blue-50"
            onClick={openCertModalAndLoad}
          >
            <User size={20} />
            <span className="text-[10px] font-medium mt-0.5">SerproID</span>
          </button>

          <button
            className="flex flex-col items-center justify-center text-gray-500 py-1 px-3 rounded-lg active:bg-gray-100"
            onClick={() => setShowAboutModal(true)}
          >
            <Settings size={20} />
            <span className="text-[10px] font-medium mt-0.5">Sobre</span>
          </button>
        </div>
      </div>

      {/* MODAL DE CERTIFICADOS (SERPRO-ID) */}
      {showCertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-2 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-4 sm:p-6 max-w-2xl w-full border border-gray-200 flex flex-col max-h-[92vh]">
            <div className="flex justify-between items-center mb-3 border-b border-gray-100 pb-3">
              <h2 className="text-lg sm:text-xl font-bold flex items-center text-gray-800 gap-2">
                <User className="text-blue-600 shrink-0" size={22} />
                <span>Certificados Digitais (SerproID)</span>
              </h2>
              <button
                onClick={() => setShowCertModal(false)}
                className="text-gray-400 hover:text-gray-800 hover:bg-gray-100 p-1.5 rounded-full transition"
              >
                &times;
              </button>
            </div>

            {/* Barra de ações rápidas SerproID Cloud */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button
                type="button"
                onClick={handleSyncCertificates}
                disabled={isLoadingCerts || isSigning}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition"
              >
                <RefreshCw size={14} />
                Sincronizar Nuvem SerproID
              </button>

              <button
                type="button"
                onClick={handlePairDevice}
                disabled={isLoadingCerts || isSigning}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
              >
                <QrCode size={14} />
                Parear Novo Dispositivo
              </button>

              <button
                type="button"
                onClick={() => setShowManualImport((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
              >
                <Upload size={14} />
                Configurar / Importar
              </button>
            </div>

            {statusMessage && (
              <div className="mb-3 px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-blue-800 text-xs flex items-center gap-2">
                <CheckCircle2 size={15} className="shrink-0 text-blue-600" />
                <span className="break-words">{statusMessage}</span>
              </div>
            )}

            {/* Painel de Pareamento SerproID */}
            {showPairPanel && serproStatus?.qrPayload && (
              <div className="mb-4 p-3.5 rounded-xl bg-gray-50 border border-gray-200 text-xs flex flex-col gap-2">
                <p className="font-semibold text-gray-800">
                  Como associar ao aplicativo SerproID:
                </p>
                <ol className="list-decimal list-inside text-gray-600 space-y-1">
                  <li>
                    Abra o app <strong>SerproID</strong> e acesse{' '}
                    <strong>Dispositivos &gt; Associar Dispositivo</strong>.
                  </li>
                  <li>
                    Utilize o código de pareamento abaixo (ou importe seu{' '}
                    <code>maquinaId</code>):
                  </li>
                </ol>
                <div className="p-2 bg-white border border-gray-200 rounded-lg font-mono text-[11px] break-all select-all">
                  {serproStatus.qrPayload}
                </div>
                <div className="flex justify-end gap-2 mt-1">
                  <button
                    type="button"
                    onClick={handleSyncCertificates}
                    className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium"
                  >
                    Já autorizei, Sincronizar agora
                  </button>
                </div>
              </div>
            )}

            {/* Painel de Importação Manual (maquinaId + .cer) */}
            {showManualImport && (
              <div className="mb-4 p-3.5 rounded-xl bg-gray-50 border border-gray-200 text-xs flex flex-col gap-2.5">
                <div className="font-semibold text-gray-800">
                  Configuração Manual do SerproID (UUID + Certificado .cer/.pem)
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">
                    X-SMARTCERT-UUID (<code>maquinaId</code>):
                  </label>
                  <input
                    type="text"
                    value={manualMaquinaId}
                    onChange={(e) => setManualMaquinaId(e.target.value)}
                    placeholder="Ex: a1b2c3d4-e5f6-..."
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white font-mono text-xs"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-gray-600 mb-1">
                      ID do Certificado (ex: nome do arquivo{' '}
                      <code>12345.cer</code>):
                    </label>
                    <input
                      type="text"
                      value={manualCertId}
                      onChange={(e) => setManualCertId(e.target.value)}
                      placeholder="Ex: 12345"
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-600 mb-1">
                      Arquivo do Certificado (<code>.cer</code> /{' '}
                      <code>.pem</code>):
                    </label>
                    <input
                      ref={certFileInputRef}
                      type="file"
                      accept=".cer,.crt,.pem,.der"
                      onChange={handleCertFileSelected}
                      className="w-full text-xs"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setShowManualImport(false)}
                    className="px-3 py-1.5 text-gray-600 hover:bg-gray-200 rounded-lg"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveManualImport}
                    className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium"
                  >
                    Salvar e Carregar
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto mb-4 pr-1">
              {isSigning ? (
                <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                  <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
                  <div className="flex items-center gap-2 text-blue-700 font-bold text-base mb-1">
                    <Smartphone size={20} />
                    <span>Confirme o PIN no aplicativo SerproID!</span>
                  </div>
                  <p className="text-xs sm:text-sm text-gray-600 max-w-md">
                    Foi enviado um pedido de assinatura digital para o seu
                    SerproID. Digite o PIN quando a notificação aparecer para
                    concluir a assinatura PAdES.
                  </p>
                </div>
              ) : isLoadingCerts ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-500">
                  <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-3"></div>
                  <p className="text-sm">Carregando certificados SerproID...</p>
                </div>
              ) : certificates.length === 0 ? (
                <div className="text-center py-8 px-4 text-gray-500 bg-gray-50 border border-dashed border-gray-300 rounded-xl">
                  <p className="font-medium text-gray-700">
                    Nenhum certificado SerproID detectado.
                  </p>
                  <p className="text-xs mt-1.5">
                    Toque em <strong>Parear Novo Dispositivo</strong> +{' '}
                    <strong>Sincronizar Nuvem SerproID</strong> acima, ou
                    importe suas credenciais em{' '}
                    <strong>Configurar / Importar</strong>.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {certificates.map((cert, i) => (
                    <div
                      key={i}
                      onClick={() => setSelectedCertIndex(i)}
                      className={`p-3.5 border rounded-xl cursor-pointer transition shadow-sm ${
                        selectedCertIndex === i
                          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                          : 'border-gray-200 bg-white hover:border-blue-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="font-bold text-gray-900 text-sm sm:text-base mb-1 truncate">
                            {cert.subject
                              ? cert.subject.replace(/:.*/, '')
                              : 'Certificado ICP-Brasil'}
                          </h3>
                          <div className="text-xs text-gray-600 flex flex-col gap-0.5">
                            <p className="truncate">
                              <strong>Emissor:</strong> {cert.issuer}
                            </p>
                            <p>
                              <strong>Validade:</strong>{' '}
                              {cert.validity?.notBefore
                                ? new Date(
                                    cert.validity.notBefore
                                  ).toLocaleDateString('pt-BR')
                                : '-'}{' '}
                              até{' '}
                              <span
                                className={
                                  cert.validity?.notAfter &&
                                  new Date(cert.validity.notAfter).getTime() <
                                    Date.now()
                                    ? 'text-red-500 font-bold'
                                    : 'text-green-600 font-bold'
                                }
                              >
                                {cert.validity?.notAfter
                                  ? new Date(
                                      cert.validity.notAfter
                                    ).toLocaleDateString('pt-BR')
                                  : '-'}
                              </span>
                            </p>
                            <p
                              className="text-[11px] text-gray-400 mt-1 font-mono truncate"
                              title={cert.slotId}
                            >
                              ID SerproID: #{cert.slotId} | Serial:{' '}
                              {cert.serialNumber}
                            </p>
                          </div>
                        </div>
                        <div
                          className={`w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center ${
                            selectedCertIndex === i
                              ? 'border-blue-600 bg-blue-600'
                              : 'border-gray-300'
                          }`}
                        >
                          {selectedCertIndex === i && (
                            <div className="w-2 h-2 bg-white rounded-full"></div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2.5 pt-3 border-t border-gray-100 mt-auto">
              <button
                onClick={() => setShowCertModal(false)}
                disabled={isSigning}
                className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-100 transition"
              >
                Cancelar
              </button>
              <button
                disabled={
                  certificates.length === 0 ||
                  selectedCertIndex === null ||
                  isLoadingCerts ||
                  isSigning ||
                  !activeTabId
                }
                onClick={async () => {
                  const cert = certificates[selectedCertIndex];
                  const activeFile = tabs.find((t) => t.id === activeTabId);

                  if (!activeFile || !activeFile.fileData) {
                    alert(
                      'Abra um documento PDF primeiro para poder assiná-lo.'
                    );
                    return;
                  }

                  setIsSigning(true);
                  setStatusMessage(null);

                  try {
                    const res = await platformBridge.signPdf({
                      filePath: activeFile.filePath,
                      fileData: activeFile.fileData,
                      originalName: activeFile.name,
                      slotId: cert.slotId,
                      keyId: cert.keyId,
                      certDerBase64: cert.rawDerBase64,
                      chainB64: cert.chainB64 || [cert.rawDerBase64],
                      signatureBox: signatureBox,
                      iconName: selectedIcon,
                    });

                    if (res.success && res.signedBytes) {
                      setTabs((prev) =>
                        prev.map((t) =>
                          t.id === activeTabId
                            ? {
                                ...t,
                                fileData: res.signedBytes!,
                                name: res.fileName || t.name,
                                filePath: res.destPath || t.filePath,
                              }
                            : t
                        )
                      );
                      setSignatureBox(null);
                      setShowCertModal(false);
                    } else if (!res.success && res.error) {
                      setStatusMessage('Erro na assinatura: ' + res.error);
                    }
                  } catch (err) {
                    setStatusMessage('Falha ao assinar: ' + String(err));
                  }
                  setIsSigning(false);
                }}
                className="px-5 py-2 rounded-xl text-sm font-medium text-white shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-700"
              >
                {isSigning ? 'Aguardando PIN...' : 'Usar Selecionado e Assinar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE ÍCONES */}
      {showIconModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-5 max-w-lg w-full border border-gray-200 flex flex-col">
            <div className="flex justify-between items-center mb-4 border-b border-gray-100 pb-3">
              <h2 className="text-lg sm:text-xl font-bold flex items-center text-gray-800 gap-2">
                <Image className="text-blue-600" size={22} />
                Escolher Ícone de Assinatura
              </h2>
              <button
                onClick={() => setShowIconModal(false)}
                className="text-gray-400 hover:text-gray-800 hover:bg-gray-100 p-1.5 rounded-full transition"
              >
                &times;
              </button>
            </div>

            <div className="flex-1 overflow-y-auto mb-2">
              <div className="grid grid-cols-1 gap-3">
                {[
                  { id: 'ipe.png', name: 'Atual (Ipê)', img: './ipe.png' },
                  {
                    id: 'brasao.png',
                    name: 'Brasão da República',
                    img: './brasao.png',
                  },
                  { id: 'ibict.png', name: 'IBICT', img: './ibict.png' },
                ].map((icon) => (
                  <div
                    key={icon.id}
                    onClick={() => {
                      setSelectedIcon(icon.id);
                      setShowIconModal(false);
                    }}
                    className={`p-3.5 border rounded-xl flex items-center gap-4 cursor-pointer transition shadow-sm ${
                      selectedIcon === icon.id
                        ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                        : 'border-gray-200 bg-white hover:border-blue-300'
                    }`}
                  >
                    <img
                      src={icon.img}
                      alt={icon.name}
                      className="w-12 h-12 object-contain"
                    />
                    <span className="font-bold text-gray-800 text-base">
                      {icon.name}
                    </span>
                    <div
                      className={`ml-auto w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                        selectedIcon === icon.id
                          ? 'border-blue-600 bg-blue-600'
                          : 'border-gray-300'
                      }`}
                    >
                      {selectedIcon === icon.id && (
                        <div className="w-2 h-2 bg-white rounded-full"></div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Sobre o Aplicativo */}
      {showAboutModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h2 className="text-lg font-bold text-gray-800 tracking-tight">
                Sobre o Assinei! (Ubuntu Touch)
              </h2>
              <button
                onClick={() => setShowAboutModal(false)}
                className="text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-full p-1 transition"
              >
                &times;
              </button>
            </div>

            <div className="p-5">
              <div className="mb-4 flex justify-center">
                <div className="h-14 flex items-center justify-center">
                  <img
                    src="./ipe.png"
                    alt="Logomarca Assinei"
                    className="h-full object-contain"
                  />
                </div>
              </div>

              <p className="text-gray-700 text-xs sm:text-sm text-justify leading-relaxed mb-4 font-medium bg-gray-50 p-3.5 border border-gray-100 rounded-xl">
                <strong>Assinei!</strong> é um sistema open-source desenvolvido
                por <strong>Tiago Emmanuel Nunes Braga</strong> para assinatura
                digital avançada de documentos PDF no padrão PAdES / ICP-Brasil
                utilizando o certificado em nuvem <strong>SerproID</strong>,
                adaptado nativamente para o <strong>Ubuntu Touch (Lomiri)</strong> e
                empacotado para a <strong>OpenStore</strong>.
              </p>

              <div className="bg-blue-50/50 rounded-xl p-3.5 border border-blue-100/50 shadow-sm flex flex-col gap-2 text-xs sm:text-sm">
                <div>
                  <span className="font-semibold text-gray-700 mr-2">
                    Repositório GIT:
                  </span>
                  <a
                    href="https://github.com/tiagobraga/Assinei-"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    Acessar o Projeto (GitHub)
                  </a>
                </div>
                <div>
                  <span className="font-semibold text-gray-700 mr-2">
                    Currículo Lattes:
                  </span>
                  <a
                    href="https://lattes.cnpq.br/8376134230259399"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:text-blue-800 hover:underline break-all"
                  >
                    Tiago Emmanuel Nunes Braga
                  </a>
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-gray-100 bg-gray-50 flex justify-center">
              <button
                onClick={() => setShowAboutModal(false)}
                className="px-6 py-2 rounded-xl text-sm font-medium text-white shadow-md transition bg-blue-600 hover:bg-blue-700"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
