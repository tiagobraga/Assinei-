import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import forge from 'node-forge';

export interface SignatureBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SignPdfParams {
  pdfBytes: Uint8Array;
  certDerBase64: string;
  chainB64Array?: string[];
  signatureBox?: SignatureBox | null;
  iconName?: string;
  signDigestCallback: (digestInfoBase64: string) => Promise<{
    success: boolean;
    signatureBase64?: string;
    error?: string;
  }>;
}

const SIGNATURE_HEX_LENGTH = 66000; // 33000 bytes em hex (espaço amplo para cadeia ICP-Brasil completa)
const BYTE_RANGE_PLACEHOLDER = '**********';

function uint8ToBinaryString(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, Array.from(sub)));
  }
  return chunks.join('');
}

function binaryStringToUint8(binStr: string): Uint8Array {
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    out[i] = binStr.charCodeAt(i) & 0xff;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Adiciona o dicionário /Sig e o Widget invisível no AcroForm usando pdf-lib puro
 * (compatível com Browser/WebEngineView sem depender de Buffer do Node.js).
 */
function addPadesPlaceholder(
  pdfDoc: PDFDocument,
  subjectName: string,
  reason = 'Assinatura Digital SERPRO-ID'
): void {
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const firstPage = pages[0];

  const byteRangeArray = PDFArray.withContext(context);
  byteRangeArray.push(PDFNumber.of(0));
  byteRangeArray.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  byteRangeArray.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  byteRangeArray.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));

  const contentsZeros = '0'.repeat(SIGNATURE_HEX_LENGTH);

  const sigDict = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: byteRangeArray,
    Contents: PDFHexString.of(contentsZeros),
    Reason: PDFString.of(reason),
    Name: PDFString.of(subjectName),
    Location: PDFString.of('BR'),
    ContactInfo: PDFString.of('SERPRO-ID / ICP-Brasil'),
    M: PDFString.fromDate(new Date()),
  });
  const sigRef = context.register(sigDict);

  const widgetDict = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    V: sigRef,
    T: PDFString.of(`Signature_${Date.now()}`),
    F: 132,
    P: firstPage.ref,
  });
  const widgetRef = context.register(widgetDict);

  // Vincula o widget às anotações da primeira página
  let annots = firstPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = context.obj([]);
    firstPage.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(widgetRef);

  // Configura AcroForm no Catalog
  let acroForm = pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    acroForm = context.obj({
      Fields: [widgetRef],
      SigFlags: 3,
    });
    pdfDoc.catalog.set(PDFName.of('AcroForm'), context.register(acroForm));
  } else {
    let fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (!fields) {
      fields = context.obj([]);
      acroForm.set(PDFName.of('Fields'), fields);
    }
    fields.push(widgetRef);
    acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  }
}

/**
 * Monta o pacote PKCS#7 / CMS SignedData de forma assíncrona, delegando a operação RSA
 * privada (DigestInfo SHA-256) para o callback do SerproID.
 */
async function buildDetachedPkcs7Async(
  signedDataBytes: Uint8Array,
  certDerBase64: string,
  chainB64Array: string[],
  signDigestCallback: SignPdfParams['signDigestCallback']
): Promise<Uint8Array> {
  const certDerBin = forge.util.decode64(certDerBase64);
  const certAsn1 = forge.asn1.fromDer(certDerBin);
  const certObj = forge.pki.certificateFromAsn1(certAsn1);

  // Calcula o SHA-256 dos bytes assinados do PDF (ByteRange[0..1] + ByteRange[2..3])
  const pdfMd = forge.md.sha256.create();
  pdfMd.update(uint8ToBinaryString(signedDataBytes));
  const pdfHashBytes = pdfMd.digest().getBytes();

  const p7 = forge.pkcs7.createSignedData();
  const effectiveChain =
    chainB64Array && chainB64Array.length > 0 ? chainB64Array : [certDerBase64];

  for (const certB64 of effectiveChain) {
    try {
      const cAsn1 = forge.asn1.fromDer(forge.util.decode64(certB64));
      const cObj = forge.pki.certificateFromAsn1(cAsn1);
      p7.addCertificate(cObj);
    } catch (e) {
      console.warn('Aviso ao adicionar certificado da cadeia:', e);
    }
  }

  // Atributos autenticados exigidos pelo padrão PAdES / ICP-Brasil
  const authenticatedAttributes = [
    {
      type: forge.pki.oids.contentType,
      value: forge.pki.oids.data,
    },
    {
      type: forge.pki.oids.messageDigest,
      value: pdfHashBytes,
    },
    {
      type: forge.pki.oids.signingTime,
      value: new Date(),
    },
  ];

  // Faz uma primeira passagem com chave dummy para que o node-forge construa
  // exatamente a estrutura ASN.1 dos authenticatedAttributes e calcule o hash deles
  let capturedAttrsDigestBytes = '';
  const dummyKey = {
    sign: (md: forge.md.MessageDigest) => {
      capturedAttrsDigestBytes = md.digest().getBytes();
      return '0'.repeat(256);
    },
  };

  p7.addSigner({
    key: dummyKey as unknown as forge.pki.rsa.PrivateKey,
    certificate: certObj,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes,
  });

  // Garante OID sha256WithRSAEncryption para validação no Adobe Reader e Verificador ITI/Gov.br
  p7.signers[p7.signers.length - 1].signatureAlgorithm =
    forge.pki.oids.sha256WithRSAEncryption;

  p7.sign({ detached: true });

  if (!capturedAttrsDigestBytes) {
    throw new Error('Falha ao capturar hash dos atributos autenticados PAdES.');
  }

  // Empacota o DigestInfo PKCS#1 (SHA-256 OID header + 32 bytes do hash)
  const digestInfoPrefixHex = '3031300d060960864801650304020105000420';
  const digestInfoPrefixBin = forge.util.hexToBytes(digestInfoPrefixHex);
  const fullDigestInfoBin = digestInfoPrefixBin + capturedAttrsDigestBytes;
  const digestInfoBase64 = forge.util.encode64(fullDigestInfoBin);

  // Solicita assinatura remota ao SerproID (envia Push PIN para o celular)
  const signRes = await signDigestCallback(digestInfoBase64);
  if (!signRes.success || !signRes.signatureBase64) {
    throw new Error(
      signRes.error || 'Não foi possível obter a assinatura do SerproID.'
    );
  }

  const realSignatureBin = forge.util.decode64(signRes.signatureBase64);

  // Reconstrói o PKCS#7 injetando a assinatura real devolvida pelo SerproID
  const p7Final = forge.pkcs7.createSignedData();
  for (const certB64 of effectiveChain) {
    try {
      const cAsn1 = forge.asn1.fromDer(forge.util.decode64(certB64));
      const cObj = forge.pki.certificateFromAsn1(cAsn1);
      p7Final.addCertificate(cObj);
    } catch {
      // ignora cert secundário malformado
    }
  }

  const realKey = {
    sign: () => realSignatureBin,
  };

  p7Final.addSigner({
    key: realKey as unknown as forge.pki.rsa.PrivateKey,
    certificate: certObj,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes,
  });
  p7Final.signers[p7Final.signers.length - 1].signatureAlgorithm =
    forge.pki.oids.sha256WithRSAEncryption;
  p7Final.sign({ detached: true });

  const cmsAsn1 = p7Final.toAsn1();
  const cmsDerBin = forge.asn1.toDer(cmsAsn1).getBytes();
  return binaryStringToUint8(cmsDerBin);
}

/**
 * Carrega bytes PNG de um ícone de assinatura (funcionando tanto em Browser/WebEngine quanto em Node).
 */
async function loadStampIconBytes(iconName: string): Promise<Uint8Array | null> {
  const safeName = iconName || 'ipe.png';
  try {
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      const resp = await window.fetch(`./${safeName}`);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
      }
    }
  } catch {
    // fallback silencioso se ícone não for encontrado
  }
  return null;
}

/**
 * Assina um PDF no padrão PAdES ICP-Brasil (Visual + Criptográfico) de forma 100% assíncrona.
 */
export async function signPdfPadesAsync(
  params: SignPdfParams
): Promise<{ success: boolean; signedBytes?: Uint8Array; error?: string }> {
  try {
    const {
      pdfBytes,
      certDerBase64,
      chainB64Array = [],
      signatureBox = null,
      iconName = 'ipe.png',
      signDigestCallback,
    } = params;

    const certAsn1 = forge.asn1.fromDer(forge.util.decode64(certDerBase64));
    const certObj = forge.pki.certificateFromAsn1(certAsn1);

    let subjectName = 'Assinante';
    const cnAttr = certObj.subject.attributes.find(
      (a) => a.shortName === 'CN' || a.name === 'commonName'
    );
    if (cnAttr && typeof cnAttr.value === 'string') {
      subjectName = cnAttr.value.split(':')[0];
    }

    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();

    let targetPageIdx = 0;
    let sigWidth = 240;
    let sigHeight = 65;
    let finalX = 0;
    let finalY = 0;

    if (signatureBox && signatureBox.w > 0 && signatureBox.h > 0) {
      targetPageIdx = Math.max(0, signatureBox.page - 1);
      const targetPageObj = pages[targetPageIdx] || pages[0];
      const { width, height } = targetPageObj.getSize();

      sigWidth = Math.max(signatureBox.w * width, 200);
      sigHeight = Math.max(signatureBox.h * height, 45);
      finalX = Math.min(signatureBox.x * width, Math.max(0, width - sigWidth));
      finalY = Math.max(0, height - signatureBox.y * height - sigHeight);
    } else {
      const lastPage = pages[pages.length - 1];
      targetPageIdx = pages.length - 1;
      const { width } = lastPage.getSize();
      finalX = Math.max(10, width - sigWidth - 40);
      finalY = 40;
    }

    const targetPage = pages[targetPageIdx] || pages[0];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const iconBytes = await loadStampIconBytes(iconName);
    let icpImg = null;
    if (iconBytes) {
      try {
        icpImg = await pdfDoc.embedPng(iconBytes);
      } catch {
        // segue sem imagem caso falhe embed
      }
    }

    targetPage.drawRectangle({
      x: finalX,
      y: finalY,
      width: sigWidth,
      height: sigHeight,
      color: rgb(0.96, 0.96, 0.98),
      borderColor: rgb(0.5, 0.5, 0.5),
      borderWidth: 1.5,
    });

    const imgPadding = Math.min(8, sigHeight * 0.1);
    const imgSize = icpImg ? sigHeight - imgPadding * 2 : 0;

    if (icpImg && imgSize > 10) {
      targetPage.drawImage(icpImg, {
        x: finalX + imgPadding,
        y: finalY + imgPadding,
        width: imgSize,
        height: imgSize,
      });
    }

    const textX = finalX + (icpImg ? imgSize + imgPadding * 2 : imgPadding * 1.5);
    const lineTop = finalY + sigHeight - imgPadding * 2;
    const dynamicFontSize = Math.max(6, Math.min(8, sigHeight * 0.15));

    if (sigWidth > textX - finalX) {
      targetPage.drawText('ASSINATURA DIGITAL', {
        x: textX,
        y: lineTop,
        size: dynamicFontSize,
        font: fontBold,
        color: rgb(0.2, 0.2, 0.2),
      });

      let shortName = subjectName;
      if (shortName.length > 28) shortName = shortName.substring(0, 25) + '...';

      const lineHeight = dynamicFontSize * 1.5;
      targetPage.drawText(shortName, {
        x: textX,
        y: lineTop - lineHeight,
        size: dynamicFontSize - 1,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });

      const dataStr = new Date().toLocaleString('pt-BR');
      targetPage.drawText(`Assinado em ${dataStr}`, {
        x: textX,
        y: lineTop - lineHeight * 2,
        size: dynamicFontSize - 2,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }

    targetPage.drawText('Fornecido por SERPRO-ID / ICP-Brasil', {
      x: textX,
      y: Math.max(finalY + 4, lineTop - 34),
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    // Adiciona o placeholder PAdES e serializa sem ObjectStreams para manter ByteRange visível
    addPadesPlaceholder(pdfDoc, subjectName);
    const preparedBytes = await pdfDoc.save({ useObjectStreams: false });
    let pdfBinStr = uint8ToBinaryString(preparedBytes);

    // Localiza o placeholder de ByteRange
    const byteRangePattern = `/ByteRange [ 0 /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER} ]`;
    const byteRangeAltPattern = `/ByteRange [0 /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER}]`;

    let brPos = pdfBinStr.indexOf(byteRangePattern);
    let matchedBrStr = byteRangePattern;
    if (brPos === -1) {
      brPos = pdfBinStr.indexOf(byteRangeAltPattern);
      matchedBrStr = byteRangeAltPattern;
    }
    if (brPos === -1) {
      throw new Error('Placeholder /ByteRange não encontrado no PDF preparado.');
    }

    // Localiza o bloco /Contents <0000...> logo após ou próximo ao /ByteRange
    const contentsSearchStart = Math.max(0, brPos - 500);
    const contentsTagPos = pdfBinStr.indexOf('/Contents <', contentsSearchStart);
    if (contentsTagPos === -1) {
      throw new Error('Placeholder /Contents não encontrado no PDF preparado.');
    }

    const hexStartPos = pdfBinStr.indexOf('<', contentsTagPos);
    const hexEndPos = pdfBinStr.indexOf('>', hexStartPos) + 1;

    const byteRangeValues = [
      0,
      hexStartPos,
      hexEndPos,
      pdfBinStr.length - hexEndPos,
    ];

    const actualByteRangeHeader = `/ByteRange [${byteRangeValues.join(' ')}]`;
    if (actualByteRangeHeader.length > matchedBrStr.length) {
      throw new Error('Espaço insuficiente no placeholder de ByteRange.');
    }
    const paddedByteRangeHeader =
      actualByteRangeHeader +
      ' '.repeat(matchedBrStr.length - actualByteRangeHeader.length);

    // Substitui o /ByteRange pelo valor exato
    pdfBinStr =
      pdfBinStr.substring(0, brPos) +
      paddedByteRangeHeader +
      pdfBinStr.substring(brPos + matchedBrStr.length);

    const pdfWithByteRangeBytes = binaryStringToUint8(pdfBinStr);

    // Extrai os bytes que compõem o documento assinado (tudo exceto o intervalo <...>)
    const signedDataBytes = new Uint8Array(
      byteRangeValues[1] + byteRangeValues[3]
    );
    signedDataBytes.set(
      pdfWithByteRangeBytes.subarray(0, byteRangeValues[1]),
      0
    );
    signedDataBytes.set(
      pdfWithByteRangeBytes.subarray(
        byteRangeValues[2],
        byteRangeValues[2] + byteRangeValues[3]
      ),
      byteRangeValues[1]
    );

    // Constrói e assina o PKCS#7 / CMS via SerproID
    const cmsDerBytes = await buildDetachedPkcs7Async(
      signedDataBytes,
      certDerBase64,
      chainB64Array,
      signDigestCallback
    );

    const cmsHex = bytesToHex(cmsDerBytes);
    const availableHexLen = hexEndPos - hexStartPos - 2;
    if (cmsHex.length > availableHexLen) {
      throw new Error(
        `Assinatura CMS (${cmsHex.length} hex chars) excede o placeholder (${availableHexLen}).`
      );
    }

    const paddedCmsHex = cmsHex + '0'.repeat(availableHexLen - cmsHex.length);

    const finalPdfBinStr =
      pdfBinStr.substring(0, hexStartPos + 1) +
      paddedCmsHex +
      pdfBinStr.substring(hexEndPos - 1);

    return {
      success: true,
      signedBytes: binaryStringToUint8(finalPdfBinStr),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Erro em signPdfPadesAsync:', err);
    return { success: false, error: message };
  }
}
