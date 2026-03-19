import React, { useState } from 'react';
import { Settings, User, ListPlus, FileSignature, Image } from 'lucide-react';
import PdfViewer from './components/PdfViewer';

declare global {
  interface Window {
    electronAPI: {
      openFileDialog: () => Promise<{ success: boolean; base64?: string; name?: string; path?: string }>;
      getCertificates: () => Promise<{ success: boolean; certs?: Certificate[]; error?: string }>;
      signPdf: (opts: { fileData?: Uint8Array; filePath?: string; originalName?: string; slotId: string; keyId: string; certDerBase64: string; chainB64: string[]; signatureBox?: { page: number, x: number, y: number, w: number, h: number } | null, iconName?: string }) => Promise<{ success: boolean; destPath?: string; error?: string }>;
      readFile: (path: string) => Promise<{ success: boolean; base64?: string; name?: string; path?: string }>;
    };
  }
}

type Tab = {
  id: string; // added to match interface
  name: string;
  filePath: string;
  fileData: Uint8Array;
  path?: string;
};

type Certificate = {
  slotId: string;
  keyId: string;
  label: string;
  subject: string;
  issuer: string;
  validity: { notBefore: string; notAfter: string };
  serialNumber: string;
  rawDerBase64: string;
  chainB64?: string[];
};

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [selectedCertIndex, setSelectedCertIndex] = useState<number>(0);
  const [signatureBox, setSignatureBox] = useState<{ page: number, x: number, y: number, w: number, h: number } | null>(null);

  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showCertModal, setShowCertModal] = useState(false);
  const [isLoadingCerts, setIsLoadingCerts] = useState(false);
  const [showIconModal, setShowIconModal] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState('ipe.png');

  const openCertModalAndLoad = async () => {
    setShowCertModal(true);
    setIsLoadingCerts(true);
    const res = await window.electronAPI.getCertificates();
    if (res.success && res.certs) {
      setCertificates(res.certs);
    } else {
      console.error(res.error);
      alert("Erro ao ler driver PKCS#11 do SERPRO: " + res.error);
    }
    setIsLoadingCerts(false);
  };

  const openPdfViaElectron = async () => {
    try {
      const response = await window.electronAPI.openFileDialog();
      if (response.success && response.base64) {
        const byteCharacters = atob(response.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        const newTabId = `tab-${Date.now()}`;
        setTabs([...tabs, { id: newTabId, name: response.name || 'documento.pdf', filePath: response.path || '', fileData: byteArray }]);
        setActiveTabId(newTabId);
      }
    } catch (error) {
      console.error("Erro ao abrir arquivo via Electron:", error);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');

      if (filesArray.length === 0) return;

      const newTabs: Tab[] = [];

      for (const file of filesArray) {
        const path = (file as any).path;
        if (path) {
          try {
            const response = await window.electronAPI.readFile(path);
            if (response.success && response.base64) {
              const byteCharacters = atob(response.base64);
              const byteArray = new Uint8Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteArray[i] = byteCharacters.charCodeAt(i);
              }
              newTabs.push({ id: `tab-${Date.now()}-${Math.random()}`, name: response.name || file.name, filePath: path, fileData: byteArray });
              continue;
            }
          } catch (err) {
            console.error("Erro no IPC de path nativo", err);
          }
        }

        const arrayBuffer = await file.arrayBuffer();
        const byteArray = new Uint8Array(arrayBuffer);
        newTabs.push({ id: `tab-${Date.now()}-${Math.random()}`, name: file.name, filePath: '', fileData: byteArray });
      }

      if (newTabs.length > 0) {
        setTabs(prev => {
          const updated = [...prev, ...newTabs];
          setActiveTabId(updated[updated.length - 1].id);
          return updated;
        });
      }
    }
  };

  return (
    <div
      className="flex h-screen bg-gray-50 text-gray-900 overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Sidebar Lateral */}
      <div className="w-16 bg-white border-r border-gray-200 flex flex-col items-center py-4 justify-between shadow-sm z-50">
        <div className="flex flex-col gap-6 w-full px-2">
          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={openPdfViaElectron}
          >
            <ListPlus size={24} />
            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-3 py-1.5 bg-gray-800 text-white text-xs font-medium rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 whitespace-nowrap">
              Abrir Documento PDF
            </span>
          </button>
        </div>

        <div className="flex flex-col gap-6 w-full px-2">
          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={() => setShowIconModal(true)}
          >
            <Image size={24} />
            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-3 py-1.5 bg-gray-800 text-white text-xs font-medium rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 whitespace-nowrap">
              Escolher Ícone de Assinatura
            </span>
          </button>

          <button
            className="group relative p-3 w-full flex justify-center text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl transition shadow-sm"
            onClick={openCertModalAndLoad}
          >
            <User size={24} />
            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-3 py-1.5 bg-gray-800 text-white text-xs font-medium rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 whitespace-nowrap">
              Certificados (Token)
            </span>
          </button>

          <button
            className="group relative p-3 w-full flex justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition"
            onClick={() => setShowAboutModal(true)}
          >
            <Settings size={24} />
            <span className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-3 py-1.5 bg-gray-800 text-white text-xs font-medium rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 whitespace-nowrap">
              Configurações
            </span>
          </button>
        </div>
      </div>

      {/* Conteúdo Principal */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Barra de Abas (Top) */}
        <div className="bg-gray-100 flex items-center px-2 pt-2 gap-1 overflow-x-auto shadow-inner border-b border-gray-200">
          {tabs.length === 0 ? (
            <div className="px-4 py-2 text-sm text-gray-500 italic">Nenhum documento aberto</div>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`min-w-32 max-w-64 flex items-center justify-between px-4 py-2 text-sm rounded-t-lg border border-b-0 cursor-pointer transition ${activeTabId === tab.id
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
                    const newTabs = tabs.filter(t => t.id !== tab.id);
                    setTabs(newTabs);
                    if (activeTabId === tab.id) {
                      setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
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
        <div className="flex-1 flex flex-col items-center justify-center overflow-auto relative bg-gray-200/50">
          {tabs.length === 0 || !activeTabId ? (
            <div className="text-center max-w-sm">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 mb-4 inline-block">
                <img src="./ipe.png" alt="Logomarca Assinei!" className="mx-auto mb-4 h-16 object-contain" />
                <h2 className="text-xl font-semibold text-gray-800">Assinei!</h2>
                <p className="text-sm text-gray-500 mt-2">Arraste seus PDFs para esta área ou clique em Abrir.</p>
              </div>
            </div>
          ) : (
            <div className="w-full h-full relative">
              <PdfViewer
                fileData={tabs.find(t => t.id === activeTabId)!.fileData}
                onSignatureChange={(page, x, y, w, h) => setSignatureBox({ page, x, y, w, h })}
              />

              {/* Overlay de Assinatura (Exemplo Base) */}
              <div className="absolute bottom-10 right-10 flex flex-col items-center">
                <button
                  title="Assinar Agora (SERPRO-ID)"
                  className="bg-blue-600 hover:bg-blue-700 text-white shadow-lg px-8 py-3 rounded-full font-medium flex items-center gap-2 transition transform hover:scale-105 active:scale-95 text-lg"
                  onClick={openCertModalAndLoad}
                >
                  <FileSignature size={20} />
                  Assinar Agora
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* MODAL DE CERTIFICADOS */}
      {
        showCertModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-2xl w-full mx-4 border border-gray-200 flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center mb-6 border-b border-gray-100 pb-4">
                <h2 className="text-2xl font-bold flex items-center text-gray-800 gap-2">
                  <User className="text-blue-600" />
                  Certificados Digitais (SERPRO-ID)
                </h2>
                <button
                  onClick={() => setShowCertModal(false)}
                  className="text-gray-400 hover:text-gray-800 hover:bg-gray-100 p-2 rounded-full transition"
                >
                  &times;
                </button>
              </div>

              <div className="flex-1 overflow-y-auto mb-6 pr-2">
                {isLoadingCerts ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                    <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
                    <p>Lendo slots criptográficos locais...</p>
                  </div>
                ) : certificates.length === 0 ? (
                  <div className="text-center py-10 text-gray-500 bg-gray-50 border border-dashed border-gray-300 rounded-xl">
                    <p>Nenhum certificado detectado.</p>
                    <p className="text-sm mt-1">Verifique se o aplicativo SERPRO-ID Desktop está em execução e o login foi realizado no celular.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {certificates.map((cert, i) => (
                      <div
                        key={i}
                        onClick={() => setSelectedCertIndex(i)}
                        className={`p-4 border rounded-xl cursor-pointer transition shadow-sm ${selectedCertIndex === i ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'}`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-bold text-gray-900 text-lg mb-1">{cert.subject ? cert.subject.replace(/:.*/, '') : 'Desconhecido'}</h3>
                            <div className="text-sm text-gray-600 flex flex-col gap-1">
                              <p><strong>Emissor:</strong> {cert.issuer}</p>
                              <p><strong>Validade:</strong> {cert.validity?.notBefore ? new Date(cert.validity.notBefore).toLocaleDateString('pt-BR') : '-'} até <span className={cert.validity?.notAfter && new Date(cert.validity.notAfter).getTime() < Date.now() ? "text-red-500 font-bold" : "text-green-600 font-bold"}>{cert.validity?.notAfter ? new Date(cert.validity.notAfter).toLocaleDateString('pt-BR') : '-'}</span></p>
                              <p className="text-xs text-gray-400 mt-2 font-mono" title={cert.slotId}>Ref Criptográfica: {cert.serialNumber}</p>
                            </div>
                          </div>
                          <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${selectedCertIndex === i ? 'border-blue-600 bg-blue-600' : 'border-gray-300'}`}>
                            {selectedCertIndex === i && <div className="w-2.5 h-2.5 bg-white rounded-full"></div>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100 mt-auto">
                <button
                  onClick={() => setShowCertModal(false)}
                  className="px-6 py-2.5 rounded-xl font-medium text-gray-600 hover:bg-gray-100 transition"
                >
                  Cancelar
                </button>
                <button
                  disabled={selectedCertIndex === null || isLoadingCerts}
                  title={selectedCertIndex === null ? "Selecione um certificado na lista acima clicando nele" : ""}
                  onClick={async () => {
                    const cert = certificates[selectedCertIndex!];
                    const activeFile = tabs.find(t => t.id === activeTabId);

                    if (!activeFile || (!activeFile.filePath && !activeFile.fileData)) {
                      alert("Nenhum PDF válido encontrado para assinatura.");
                      return;
                    }

                    setIsLoadingCerts(true);

                    try {
                      const res = await window.electronAPI.signPdf({
                        filePath: activeFile.filePath,
                        fileData: activeFile.fileData,
                        originalName: activeFile.name,
                        slotId: cert.slotId,
                        keyId: cert.keyId,
                        certDerBase64: cert.rawDerBase64,
                        chainB64: cert.chainB64 || [],
                        signatureBox: signatureBox,
                        iconName: selectedIcon
                      });

                      if (res.success && res.destPath) {
                        // Silencia o alerta invasivo, deixando que o usuário veja a assinatura recarregada no local marcado
                        try {
                          const reloadRes = await window.electronAPI.readFile(res.destPath);
                          if (reloadRes.success && reloadRes.base64) {
                            // Converte base64 de volta para fileData
                            const binaryString = window.atob(reloadRes.base64);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                              bytes[i] = binaryString.charCodeAt(i);
                            }

                            // Atualiza a Tab com o Arquivo Assinado + Limpa o seletor da UI
                            setTabs(prev => prev.map(t =>
                              t.id === activeTabId
                                ? { ...t, fileData: bytes, name: reloadRes.name || t.name, filePath: res.destPath! }
                                : t
                            ));
                            setSignatureBox(null);
                          }
                        } catch (e) {
                          console.error("Falha ao recarregar a tela", e);
                        }

                        setShowCertModal(false);
                      } else if (!res.success && res.error) {
                        alert("Erro ao envelopar PKCS#7 / Injetar PDF ou Ação Cancelada:\n" + res.error);
                      }
                    } catch (err) {
                      alert("Falha cataclísmica IPC: " + String(err));
                    }
                    setIsLoadingCerts(false);
                  }}
                  className="px-6 py-2.5 rounded-xl font-medium text-white shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-700"
                >
                  Usar Selecionado e Assinar
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* MODAL DE ÍCONES */}
      {
        showIconModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-lg w-full mx-4 border border-gray-200 flex flex-col">
              <div className="flex justify-between items-center mb-6 border-b border-gray-100 pb-4">
                <h2 className="text-2xl font-bold flex items-center text-gray-800 gap-2">
                  <Image className="text-blue-600" />
                  Escolher Ícone de Assinatura
                </h2>
                <button
                  onClick={() => setShowIconModal(false)}
                  className="text-gray-400 hover:text-gray-800 hover:bg-gray-100 p-2 rounded-full transition"
                >
                  &times;
                </button>
              </div>

              <div className="flex-1 overflow-y-auto mb-6 pr-2">
                <div className="grid grid-cols-1 gap-4">
                  {[
                    { id: 'ipe.png', name: 'Atual (Ipê)', img: './ipe.png' },
                    { id: 'brasao.png', name: 'Brasão da República', img: './brasao.png' },
                    { id: 'ibict.png', name: 'IBICT', img: './ibict.png' }
                  ].map(icon => (
                    <div
                      key={icon.id}
                      onClick={() => {
                        setSelectedIcon(icon.id);
                        setShowIconModal(false);
                      }}
                      className={`p-4 border rounded-xl flex items-center gap-4 cursor-pointer transition shadow-sm ${selectedIcon === icon.id ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'}`}
                    >
                      <img src={icon.img} alt={icon.name} className="w-16 h-16 object-contain" />
                      <span className="font-bold text-gray-800 text-lg">{icon.name}</span>
                      <div className={`ml-auto w-6 h-6 rounded-full border-2 flex items-center justify-center ${selectedIcon === icon.id ? 'border-blue-600 bg-blue-600' : 'border-gray-300'}`}>
                        {selectedIcon === icon.id && <div className="w-2.5 h-2.5 bg-white rounded-full"></div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      }

      {/* Modal Sobre o Aplicativo (Configurações) */}
      {
        showAboutModal && (
          <div className="fixed top-0 left-0 w-full h-full bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center">
            <div className="bg-white rounded-2xl shadow-xl w-[480px] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">

              {/* Header Modal */}
              <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <h2 className="text-xl font-bold text-gray-800 tracking-tight">Sobre o Assinei!</h2>
                <button
                  onClick={() => setShowAboutModal(false)}
                  className="text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-full p-1 transition"
                >
                  &times;
                </button>
              </div>

              <div className="p-6">
                <div className="mb-6 flex justify-center">
                  <div className="h-16 flex items-center justify-center">
                    <img src="./ipe.png" alt="Logomarca Assinei" className="h-full object-contain" />
                  </div>
                </div>

                <p className="text-gray-700 text-sm text-justify leading-relaxed mb-6 font-medium bg-gray-50 p-4 border border-gray-100 rounded-xl">
                  <strong>Assinei!</strong> é um sistema desenvolvido em Vibe Coding que permite a assinatura em lote de documentos no formato PDF utilizando os certificados SERPROID com base no padrão ICP Brasil. Ele é um projeto opensource desenvolvido por Tiago Emmanuel Nunes Braga.
                </p>

                <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100/50 shadow-sm flex flex-col gap-3">
                  <div className="text-sm">
                    <span className="font-semibold text-gray-700 mr-2">Repositório GIT:</span>
                    <a href="https://github.com/tiagobraga/Assinei-" target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline">
                      Acessar o Projeto (GitHub)
                    </a>
                  </div>
                  <div className="text-sm">
                    <span className="font-semibold text-gray-700 mr-2">Currículo Lattes:</span>
                    <a href="https://lattes.cnpq.br/8376134230259399" target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline break-all">
                      Tiago Emmanuel Nunes Braga
                    </a>
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-center">
                <button
                  onClick={() => setShowAboutModal(false)}
                  className="px-6 py-2.5 rounded-xl font-medium text-white shadow-md transition bg-blue-600 hover:bg-blue-700"
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
