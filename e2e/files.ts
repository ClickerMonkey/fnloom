/**
 * Small real files the e2e suites upload: a one-page PDF with text written out by hand (every object and the xref
 * offsets made here, so no PDF library is needed) and a two-sheet workbook made with `xlsx`, the parser the hub
 * converts workbooks with.
 */
import * as XLSX from 'xlsx';

/** PDF text with its special characters escaped. */
function pdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** A one-page PDF whose page shows `lines`, one per line, in Helvetica. */
export function minimalPdf(lines: readonly string[]): Uint8Array {
  const stream = ['BT', '/F1 18 Tf', '72 720 Td', '22 TL', ...lines.map((line, i) => `${i === 0 ? '' : 'T* '}(${pdfText(line)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A workbook (xlsx) with one sheet per entry, each a header row then its rows. */
export function workbook(sheets: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string | number>>>>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) { XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map((row) => [...row])), name); }
  const written: unknown = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  if (!(written instanceof ArrayBuffer)) { throw new Error('xlsx wrote something other than bytes'); }
  return new Uint8Array(written);
}
