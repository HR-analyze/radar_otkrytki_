/**
 * Серверная точка входа pdfmake (`js/index.js`) и встроенный Roboto.
 *
 * @types/pdfmake описывает только браузерную сборку: там нет ни `virtualfs`,
 * ни политик доступа, а шрифты вообще не типизированы. Описываем ровно то,
 * чем пользуемся в contest-pdf.ts.
 */
declare module 'pdfmake' {
  import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';

  interface VirtualFileSystem {
    writeFileSync(filename: string, content: string, encoding?: string): void;
  }

  interface CreatedPdf {
    getBuffer(): Promise<Buffer>;
  }

  interface PdfMakeServer {
    virtualfs: VirtualFileSystem;
    setFonts(fonts: TFontDictionary): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(definition: TDocumentDefinitions): CreatedPdf;
  }

  const pdfMake: PdfMakeServer;
  export default pdfMake;
}

declare module 'pdfmake/build/fonts/Roboto' {
  const container: {
    vfs: Record<string, { data: string; encoding: string }>;
    fonts: Record<string, Record<string, string>>;
  };
  export default container;
}
