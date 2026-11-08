/**
 * Drawing pdf pages (`PdfDocuments`): pdf.js, loaded the first time a pdf is opened, with its worker from the app's
 * own build, draws one page at a time onto a canvas at the width it is shown and the screen's pixel density. The
 * viewer asks through `PDF_DOCUMENTS`, so tests and other engines can stand in; without one (or when a pdf won't
 * open) it shows the browser's own viewer.
 */
import type * as PdfJs from 'pdfjs-dist';
import type { InjectionKey } from 'vue';

/** An opened pdf. */
export interface PdfDocument {
  readonly pages: number;
  /** Draw page `page` (1-based) onto `canvas`, `width` CSS pixels wide, at `density` device pixels per CSS pixel. */
  draw(page: number, canvas: HTMLCanvasElement, width: number, density: number): Promise<void>;
  close(): Promise<void>;
}

/** Opens pdfs by URL. */
export interface PdfDocuments {
  open(url: string): Promise<PdfDocument>;
}

/** Where the pdf viewer finds the app's pdf engine. */
export const PDF_DOCUMENTS: InjectionKey<PdfDocuments | undefined> = Symbol('harness.pdf');

/** The page the viewer asks for, kept within the document. */
export function clampPage(page: number, pages: number): number {
  return Math.max(1, pages > 0 ? Math.min(pages, Math.floor(page)) : Math.floor(page));
}

/** pdf.js, imported (with the URL of its worker in this build) the first time a pdf is opened. */
export class PdfJsDocuments implements PdfDocuments {
  #engine: Promise<typeof PdfJs> | undefined;

  async open(url: string): Promise<PdfDocument> {
    this.#engine ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
    const pdfjs = await this.#engine;
    const task = pdfjs.getDocument({ url });
    const pdf = await task.promise;
    return {
      pages: pdf.numPages,
      async draw(page, canvas, width, density) {
        const opened = await pdf.getPage(page);
        const natural = opened.getViewport({ scale: 1 });
        const viewport = opened.getViewport({ scale: (width / natural.width) * density });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / density)}px`;
        canvas.style.height = `${Math.floor(viewport.height / density)}px`;
        await opened.render({ canvas, viewport }).promise;
      },
      // destroying the loading task stops its requests and its worker
      close: () => task.destroy(),
    };
  }
}
