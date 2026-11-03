import { signPdfPadesAsync, type SignatureBox } from './padesClientSigner';

export interface Certificate {
  slotId: string;
  keyId: string;
  label: string;
  subject: string;
  issuer: string;
  validity: { notBefore: string; notAfter: string };
  serialNumber: string;
  rawDerBase64: string;
  chainB64?: string[];
}

export interface SerproIdStatus {
  success: boolean;
  paired?: boolean;
  maquinaId?: string;
  ambiente?: string;
  certificatesCount?: number;
  qrPayload?: string | null;
  hostname?: string;
  username?: string;
  error?: string;
}

export interface ImportedPdfFile {
  name: string;
  path: string;
  fileData: Uint8Array;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, Array.from(sub)));
  }
  return window.btoa(chunks.join(''));
}

class PlatformBridge {
  private isUbuntuTouchBackendAvailable: boolean | null = null;

  async checkUbuntuTouchBackend(): Promise<boolean> {
    if (this.isUbuntuTouchBackendAvailable !== null) {
      return this.isUbuntuTouchBackendAvailable;
    }
    try {
      const resp = await fetch('/api/health', { method: 'GET' });
      if (resp.ok) {
        const data = await resp.json();
        this.isUbuntuTouchBackendAvailable = Boolean(data && data.ok);
        return this.isUbuntuTouchBackendAvailable;
      }
    } catch {
      // Não está rodando sob o servidor Python do Ubuntu Touch
    }
    this.isUbuntuTouchBackendAvailable = false;
    return false;
  }

  isElectron(): boolean {
    return typeof window !== 'undefined' && Boolean(window.electronAPI);
  }

  /**
   * Busca arquivos PDF que foram abertos pelo Lomiri Content Hub ("Abrir com Assinei!" ou ContentPeerPicker).
   */
  async fetchPendingContentHubFiles(): Promise<ImportedPdfFile[]> {
    const isUT = await this.checkUbuntuTouchBackend();
    if (!isUT) return [];

    try {
      const resp = await fetch('/api/pending-files');
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!data.success || !Array.isArray(data.files)) return [];

      return data.files.map(
        (f: { name: string; path: string; base64: string }) => ({
          name: f.name || 'documento.pdf',
          path: f.path || '',
          fileData: base64ToUint8Array(f.base64),
        })
      );
    } catch (err) {
      console.error('Erro ao buscar arquivos pendentes do Content Hub:', err);
      return [];
    }
  }

  /**
   * Aciona o seletor de arquivos do Lomiri Content Hub no Ubuntu Touch
   * ou o diálogo nativo no Electron.
   */
  async requestContentHubImport(): Promise<boolean> {
    const isUT = await this.checkUbuntuTouchBackend();
    if (isUT) {
      try {
        const resp = await fetch('/api/request-open-dialog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return resp.ok;
      } catch {
        return false;
      }
    }
    return false;
  }

  async readFile(
    filePath: string
  ): Promise<{ success: boolean; base64?: string; name?: string; path?: string; error?: string }> {
    if (this.isElectron()) {
      return window.electronAPI.readFile(filePath);
    }
    const isUT = await this.checkUbuntuTouchBackend();
    if (isUT) {
      const resp = await fetch('/api/read-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      return resp.json();
    }
    return { success: false, error: 'Leitura direta de caminho não suportada neste ambiente.' };
  }

  async getCertificates(): Promise<{
    success: boolean;
    certs?: Certificate[];
    paired?: boolean;
    maquinaId?: string;
    error?: string;
  }> {
    if (this.isElectron()) {
      return window.electronAPI.getCertificates();
    }
    const isUT = await this.checkUbuntuTouchBackend();
    if (isUT) {
      try {
        const resp = await fetch('/api/certificates');
        return await resp.json();
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    return {
      success: false,
      error: 'Backend de certificados SerproID não detectado.',
    };
  }

  async getSerproIdStatus(): Promise<SerproIdStatus> {
    const isUT = await this.checkUbuntuTouchBackend();
    if (!isUT) {
      return { success: true, paired: true };
    }
    try {
      const resp = await fetch('/api/serproid/status');
      return await resp.json();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async pairSerproIdDevice(hostname?: string): Promise<SerproIdStatus> {
    try {
      const resp = await fetch('/api/serproid/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname }),
      });
      return await resp.json();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async syncSerproIdCertificates(): Promise<{
    success: boolean;
    installedCount?: number;
    certs?: Certificate[];
    error?: string;
  }> {
    try {
      const resp = await fetch('/api/serproid/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return await resp.json();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async importManualSerproId(opts: {
    maquinaId?: string;
    certId?: string;
    certData?: string;
  }): Promise<{ success: boolean; certs?: Certificate[]; error?: string }> {
    try {
      const resp = await fetch('/api/serproid/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      return await resp.json();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Assina o PDF usando o certificado selecionado:
   * - No Ubuntu Touch: gera o PDF PAdES via signPdfPadesAsync, envia o DigestInfo SHA-256
   *   para a nuvem SerproID (que dispara o Push PIN no celular), injeta o CMS/PKCS#7,
   *   salva no diretório de exportação e abre o Lomiri Content Hub para salvar/compartilhar!
   * - No Electron Desktop: delega para window.electronAPI.signPdf.
   */
  async signPdf(opts: {
    fileData: Uint8Array;
    filePath?: string;
    originalName?: string;
    slotId: string;
    keyId: string;
    certDerBase64: string;
    chainB64: string[];
    signatureBox?: SignatureBox | null;
    iconName?: string;
  }): Promise<{
    success: boolean;
    destPath?: string;
    signedBytes?: Uint8Array;
    fileName?: string;
    error?: string;
  }> {
    if (this.isElectron()) {
      const res = await window.electronAPI.signPdf(opts);
      if (res.success && res.destPath) {
        const reloadRes = await window.electronAPI.readFile(res.destPath);
        if (reloadRes.success && reloadRes.base64) {
          return {
            success: true,
            destPath: res.destPath,
            fileName: reloadRes.name || opts.originalName,
            signedBytes: base64ToUint8Array(reloadRes.base64),
          };
        }
      }
      return res;
    }

    const isUT = await this.checkUbuntuTouchBackend();

    if (isUT) {
      const resp = await fetch('/api/sign-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: uint8ArrayToBase64(opts.fileData),
          slotId: opts.slotId,
          certDerBase64: opts.certDerBase64,
          chainB64: opts.chainB64,
          originalName: opts.originalName || 'documento.pdf',
          signatureBox: opts.signatureBox,
          iconName: opts.iconName || 'ipe.png',
        }),
      });
      const data = await resp.json();
      if (!data.success) {
        return { success: false, error: data.error };
      }
      return {
        success: true,
        destPath: data.destPath,
        fileName: data.fileName,
        signedBytes: data.signedBase64
          ? base64ToUint8Array(data.signedBase64)
          : opts.fileData,
      };
    }

    // Fallback WebEngine / Navegador PAdES + SerproID Cloud
    const padesRes = await signPdfPadesAsync({
      pdfBytes: opts.fileData,
      certDerBase64: opts.certDerBase64,
      chainB64Array: opts.chainB64,
      signatureBox: opts.signatureBox,
      iconName: opts.iconName,
      signDigestCallback: async (digestInfoBase64: string) => {
        const resp = await fetch('/api/serproid/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slotId: opts.slotId,
            digestInfoBase64,
          }),
        });
        return await resp.json();
      },
    });

    if (!padesRes.success || !padesRes.signedBytes) {
      return {
        success: false,
        error: padesRes.error || 'Falha ao gerar assinatura PAdES.',
      };
    }

    // Fallback navegador puro: dispara download do arquivo _tb.pdf
    const outName = (opts.originalName || 'documento.pdf').replace(
      /\.pdf$/i,
      '_tb.pdf'
    );
    const blob = new Blob([padesRes.signedBytes.slice().buffer], {
      type: 'application/pdf',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return {
      success: true,
      destPath: outName,
      fileName: outName,
      signedBytes: padesRes.signedBytes,
    };
  }
}

export const platformBridge = new PlatformBridge();
