/**
 * Cutting a markdown text at its headings: the authoring guide's parts are its sections. fs serves the parts with it,
 * and the docs generator sizes them with it, so both cut the guide the same way.
 */

/**
 * The section of a markdown text that starts at a heading line and runs to the line `until` (or the end), trimmed.
 * Undefined when the heading isn't a line of the text. Line ends are read as `\n`.
 */
export function sectionOf(text: string, heading: string, until?: string): string | undefined {
  // framed in line ends, so a heading on the first or the last line is found like any other
  const lines = `\n${text.replaceAll('\r\n', '\n')}\n`;
  const start = lines.indexOf(`\n${heading}\n`);
  if (start < 0) { return undefined; }
  const end = until === undefined ? -1 : lines.indexOf(`\n${until}\n`, start + 1);
  return lines.slice(start + 1, end < 0 ? lines.length : end).trimEnd();
}
