import React, { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Hand, PenTool, ZoomIn, ZoomOut } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface PdfViewerProps {
  fileData: string | Uint8Array;
  onSignatureChange?: (
    page: number,
    x: number,
    y: number,
    w: number,
    h: number
  ) => void;
}

const PdfViewer: React.FC<PdfViewerProps> = ({
  fileData,
  onSignatureChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [signatureBox, setSignatureBox] = useState<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    containerW: number;
    containerH: number;
  } | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawState, setDrawState] = useState<{
    page: number;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  // No Ubuntu Touch (telas touch), permite alternar entre Rolar o PDF e Posicionar a Assinatura
  const [interactionMode, setInteractionMode] = useState<'scroll' | 'stamp'>(
    'stamp'
  );
  const [pageWidth, setPageWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth < 640
        ? Math.max(260, window.innerWidth - 24)
        : Math.min(820, window.innerWidth - 120);
    }
    return 720;
  });

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 640) {
        setPageWidth(Math.max(260, window.innerWidth - 24));
      } else {
        setPageWidth(Math.min(820, window.innerWidth - 120));
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  useEffect(() => {
    setSignatureBox(null);
    if (onSignatureChange) onSignatureChange(1, 0, 0, 0, 0);
  }, [fileData]);

  const startDrawingAt = (
    clientX: number,
    clientY: number,
    targetEl: HTMLDivElement,
    pageIndex: number
  ) => {
    const rect = targetEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

    // Define um tamanho mínimo padrão (proporcional à página) para toques rápidos no celular
    const defaultW = Math.min(rect.width - x, Math.max(120, rect.width * 0.38));
    const defaultH = Math.min(
      rect.height - y,
      Math.max(42, rect.height * 0.08)
    );

    setDrawState({
      page: pageIndex + 1,
      startX: x,
      startY: y,
      curX: x,
      curY: y,
    });
    setSignatureBox({
      page: pageIndex + 1,
      x,
      y,
      w: defaultW,
      h: defaultH,
      containerW: rect.width,
      containerH: rect.height,
    });
    setIsDrawing(true);
  };

  const moveDrawingAt = (
    clientX: number,
    clientY: number,
    targetEl: HTMLDivElement,
    pageIndex: number
  ) => {
    if (!isDrawing || !drawState || drawState.page !== pageIndex + 1) return;

    const rect = targetEl.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const currentY = Math.max(0, Math.min(rect.height, clientY - rect.top));

    setDrawState((prev) =>
      prev ? { ...prev, curX: currentX, curY: currentY } : null
    );

    const rawW = Math.abs(currentX - drawState.startX);
    const rawH = Math.abs(currentY - drawState.startY);

    // Se o usuário arrastou mais de 12px, usa o retângulo desenhado; senão mantém o tamanho padrão de toque
    const w = rawW > 12 ? rawW : Math.max(120, rect.width * 0.38);
    const h = rawH > 12 ? rawH : Math.max(42, rect.height * 0.08);

    setSignatureBox({
      page: pageIndex + 1,
      x: Math.min(drawState.startX, currentX),
      y: Math.min(drawState.startY, currentY),
      w,
      h,
      containerW: rect.width,
      containerH: rect.height,
    });
  };

  const finishDrawing = () => {
    if (isDrawing) {
      setIsDrawing(false);
      if (signatureBox && signatureBox.w > 0 && signatureBox.h > 0) {
        if (onSignatureChange) {
          onSignatureChange(
            signatureBox.page,
            signatureBox.x / signatureBox.containerW,
            signatureBox.y / signatureBox.containerH,
            signatureBox.w / signatureBox.containerW,
            signatureBox.h / signatureBox.containerH
          );
        }
      }
    }
  };

  const handleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    pageIndex: number
  ) => {
    if (interactionMode !== 'stamp') return;
    startDrawingAt(e.clientX, e.clientY, e.currentTarget, pageIndex);
  };

  const handleMouseMove = (
    e: React.MouseEvent<HTMLDivElement>,
    pageIndex: number
  ) => {
    if (interactionMode !== 'stamp') return;
    moveDrawingAt(e.clientX, e.clientY, e.currentTarget, pageIndex);
  };

  const handleTouchStart = (
    e: React.TouchEvent<HTMLDivElement>,
    pageIndex: number
  ) => {
    if (interactionMode !== 'stamp') return;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      startDrawingAt(touch.clientX, touch.clientY, e.currentTarget, pageIndex);
    }
  };

  const handleTouchMove = (
    e: React.TouchEvent<HTMLDivElement>,
    pageIndex: number
  ) => {
    if (interactionMode !== 'stamp') return;
    if (isDrawing && e.touches.length === 1) {
      e.preventDefault();
      const touch = e.touches[0];
      moveDrawingAt(touch.clientX, touch.clientY, e.currentTarget, pageIndex);
    }
  };

  const clearSignature = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setSignatureBox(null);
    if (onSignatureChange) onSignatureChange(1, 0, 0, 0, 0);
  };

  const pdfFile = React.useMemo(() => {
    if (fileData instanceof Uint8Array) {
      return { data: fileData.slice() };
    }
    return { data: fileData };
  }, [fileData]);

  return (
    <div
      className="flex flex-col items-center w-full h-full relative overflow-y-auto bg-gray-200/60 p-3 sm:p-8 pb-28"
      onMouseUp={finishDrawing}
      onMouseLeave={finishDrawing}
      onTouchEnd={finishDrawing}
    >
      {/* Barra de Ferramentas Touch Flutuante (Superior) */}
      <div className="sticky top-2 z-30 mb-3 flex items-center gap-1.5 bg-white/95 backdrop-blur-md px-3 py-1.5 rounded-full shadow-md border border-gray-200 text-xs sm:text-sm">
        <button
          type="button"
          onClick={() => setInteractionMode('scroll')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
            interactionMode === 'scroll'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-gray-600 hover:bg-gray-100'
          }`}
          title="Rolar páginas com o dedo"
        >
          <Hand size={15} />
          <span>Rolar PDF</span>
        </button>

        <button
          type="button"
          onClick={() => setInteractionMode('stamp')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
            interactionMode === 'stamp'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-gray-600 hover:bg-gray-100'
          }`}
          title="Toque ou arraste no PDF para marcar o local da assinatura"
        >
          <PenTool size={15} />
          <span>Posicionar Assinatura</span>
        </button>

        <div className="h-4 w-px bg-gray-200 mx-1" />

        <button
          type="button"
          onClick={() => setPageWidth((w) => Math.max(240, w - 60))}
          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full"
          title="Reduzir Zoom"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          onClick={() => setPageWidth((w) => Math.min(1200, w + 60))}
          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full"
          title="Aumentar Zoom"
        >
          <ZoomIn size={16} />
        </button>
      </div>

      <div className="flex flex-col gap-6 items-center" ref={containerRef}>
        <Document
          file={pdfFile}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={
            <div className="text-gray-500 font-medium py-12">
              Carregando Documento PDF...
            </div>
          }
          error={
            <div className="flex flex-col items-center p-6 bg-red-50 border border-red-200 rounded-lg max-w-md text-center">
              <span className="text-red-600 font-bold mb-1">
                Falha ao carregar o documento PDF
              </span>
              <span className="text-red-500 text-xs">
                Verifique se o arquivo é um PDF válido e não está corrompido.
              </span>
            </div>
          }
          onLoadError={(error) => console.error('React-PDF Error:', error)}
        >
          {Array.from(new Array(numPages), (_, index) => (
            <div
              key={`page_${index + 1}`}
              className={`relative mb-6 shadow-xl border border-gray-300 rounded-sm bg-white select-none ${
                interactionMode === 'stamp'
                  ? 'cursor-crosshair touch-none'
                  : 'cursor-grab touch-pan-y'
              }`}
              onMouseDown={(e) => handleMouseDown(e, index)}
              onMouseMove={(e) => handleMouseMove(e, index)}
              onTouchStart={(e) => handleTouchStart(e, index)}
              onTouchMove={(e) => handleTouchMove(e, index)}
            >
              <Page
                pageNumber={index + 1}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                width={pageWidth}
              />

              {/* Overlay da Assinatura */}
              {signatureBox &&
                signatureBox.page === index + 1 &&
                signatureBox.w > 0 &&
                signatureBox.h > 0 && (
                  <div
                    className="absolute border-2 border-blue-600 bg-blue-100/50 flex items-center justify-center p-1 rounded-sm"
                    style={{
                      left: `${signatureBox.x}px`,
                      top: `${signatureBox.y}px`,
                      width: `${signatureBox.w}px`,
                      height: `${signatureBox.h}px`,
                      pointerEvents: 'none',
                    }}
                  >
                    <div className="text-blue-900 font-semibold text-xs text-center drop-shadow-sm flex flex-col items-center pointer-events-auto">
                      <span>Local da Assinatura</span>
                      <span className="text-[10px]">
                        (Pág {signatureBox.page})
                      </span>
                      {!isDrawing && (
                        <button
                          type="button"
                          onClick={clearSignature}
                          onTouchEnd={clearSignature}
                          className="mt-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex justify-center items-center cursor-pointer shadow-sm"
                          title="Remover marcação"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  </div>
                )}
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
};

export default PdfViewer;
