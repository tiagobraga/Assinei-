import React, { useState, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface PdfViewerProps {
    fileData: string | Uint8Array;
    onSignatureChange?: (page: number, x: number, y: number, w: number, h: number) => void;
}

const PdfViewer: React.FC<PdfViewerProps> = ({ fileData, onSignatureChange }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [numPages, setNumPages] = useState<number>(0);
    const [signatureBox, setSignatureBox] = useState<{ page: number, x: number, y: number, w: number, h: number, containerW: number, containerH: number } | null>(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [drawState, setDrawState] = useState<{ page: number, startX: number, startY: number, curX: number, curY: number } | null>(null);

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
    };

    // Apaga a seleção visual customizada se o arquivo for alterado (Ex: Acabou de ser assinado)
    React.useEffect(() => {
        setSignatureBox(null);
        if (onSignatureChange) onSignatureChange(1, 0, 0, 0, 0);
    }, [fileData]);

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setDrawState({ page: pageIndex + 1, startX: x, startY: y, curX: x, curY: y });
        setSignatureBox({ page: pageIndex + 1, x, y, w: 0, h: 0, containerW: rect.width, containerH: rect.height });
        setIsDrawing(true);
    };

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
        if (!isDrawing || !drawState || drawState.page !== pageIndex + 1) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        setDrawState(prev => prev ? { ...prev, curX: currentX, curY: currentY } : null);

        setSignatureBox({
            page: pageIndex + 1,
            x: Math.min(drawState.startX, currentX),
            y: Math.min(drawState.startY, currentY),
            w: Math.abs(currentX - drawState.startX),
            h: Math.abs(currentY - drawState.startY),
            containerW: rect.width,
            containerH: rect.height
        });
    };

    const handleMouseUp = () => {
        if (isDrawing) {
            setIsDrawing(false);
            if (signatureBox && signatureBox.w > 0 && signatureBox.h > 0) {
                if (onSignatureChange) {
                    onSignatureChange(
                        signatureBox.page,
                        signatureBox.x / signatureBox.containerW,  // Envia como porcentagem relativa % (ex: 0.15)
                        signatureBox.y / signatureBox.containerH,
                        signatureBox.w / signatureBox.containerW,
                        signatureBox.h / signatureBox.containerH
                    );
                }
            }
        }
    };

    const clearSignature = (e: React.MouseEvent) => {
        e.stopPropagation();
        setSignatureBox(null);
        if (onSignatureChange) onSignatureChange(1, 0, 0, 0, 0);
    };

    // Cria uma cópia profunda (clonagem) do Uint8Array porque o Worker do pdfjs
    // internamente transfere a propriedade do buffer, "desanexando-o" da thread principal.
    // Sem esse `.slice()`, trocar de abas quebra o arquivo permanentemente no estado do App.
    const pdfFile = React.useMemo(() => {
        if (fileData instanceof Uint8Array) {
            return { data: fileData.slice() };
        }
        return { data: fileData };
    }, [fileData]);

    return (
        <div
            className="flex flex-col items-center w-full h-full relative overflow-y-auto bg-gray-200/50 p-8"
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
            <div className="flex flex-col gap-6" ref={containerRef}>
                <Document
                    file={pdfFile}
                    onLoadSuccess={onDocumentLoadSuccess}
                    loading={
                        <div className="text-gray-500 font-medium">Carregando Documento...</div>
                    }
                    error={
                        <div className="flex flex-col items-center p-8 bg-red-50 border border-red-200 rounded-lg max-w-lg">
                            <span className="text-red-600 font-bold mb-2">Falha ao carregar o documento PDF</span>
                            <span className="text-red-500 font-mono text-sm break-all">Verifique o console (Ctrl+Shift+I)</span>
                        </div>
                    }
                    onLoadError={(error) => console.error('React-PDF Error:', error)}
                >
                    {Array.from(new Array(numPages), (_, index) => (
                        <div
                            key={`page_${index + 1}`}
                            className="relative mb-6 shadow-xl border border-gray-300 rounded-sm cursor-crosshair bg-white"
                            onMouseDown={(e) => handleMouseDown(e, index)}
                            onMouseMove={(e) => handleMouseMove(e, index)}
                        >
                            <Page
                                pageNumber={index + 1}
                                renderTextLayer={false}
                                renderAnnotationLayer={false}
                                scale={1.5}
                            />

                            {/* Overlay da Assinatura */}
                            {signatureBox && signatureBox.page === index + 1 && signatureBox.w > 0 && signatureBox.h > 0 && (
                                <div
                                    className="absolute border-2 border-blue-500 bg-blue-100/40 flex items-center justify-center p-1"
                                    style={{
                                        left: `${signatureBox.x}px`,
                                        top: `${signatureBox.y}px`,
                                        width: `${signatureBox.w}px`,
                                        height: `${signatureBox.h}px`,
                                        pointerEvents: 'none', // Não bloquear o mouseUp do pai
                                    }}
                                >
                                    <div className="text-blue-800 font-semibold text-xs text-center drop-shadow-md flex flex-col items-center pointer-events-auto">
                                        <span>Local da Assinatura</span>
                                        <span>(Pág {signatureBox.page})</span>
                                        {!isDrawing && (
                                            <button
                                                onClick={clearSignature}
                                                className="mt-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex justify-center items-center cursor-pointer shadow-sm"
                                                title="Remover assinatura"
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
        </div >
    );
};

export default PdfViewer;
