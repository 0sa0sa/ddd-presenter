/**
 * Models often answer a "continue at the cursor" request with text indented for column 0,
 * or repeat the `- ` that is already on the line. This fits a continuation to the cursor's line.
 */
export function fitToCursor(yaml: string, offset: number, suggestion: string): string {
  const lineStart = yaml.lastIndexOf("\n", offset - 1) + 1;
  const prefix = yaml.slice(lineStart, offset);
  if (prefix.trim() && !/^\s*-\s*$/.test(prefix)) return suggestion; // mid-line: nothing to fit
  if (!prefix) return suggestion; // column 0: no indentation to fit to
  const lines = suggestion.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]!.trim()) return suggestion; // continues on the next line: already positioned
  let first = lines[0]!;
  const onDash = /-\s*$/.test(prefix);
  // Drop the indentation (and dash) the line already has.
  if (!onDash) {
    const indent = prefix.length;
    const lead = /^\s*/.exec(first)![0].length;
    first = first.slice(Math.min(lead, indent));
  } else {
    first = first.trimStart();
    if (first.startsWith("- ")) first = first.slice(2);
    else if (first === "-") first = "";
    if (!prefix.endsWith(" ") && first) first = ` ${first}`;
  }
  const rest = lines.slice(1);
  // Keys that continue the first line's mapping belong at the column where the first line's text starts.
  const column = onDash ? prefix.length + (prefix.endsWith(" ") ? 0 : 1) : prefix.length + (first.startsWith("- ") ? 2 : 0);
  const indents = rest.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const shift = indents.length ? column - Math.min(...indents) : 0;
  const shifted = rest.map((l) => (!l.trim() ? l : shift >= 0 ? " ".repeat(shift) + l : l.slice(-shift)));
  return [first, ...shifted].join("\n");
}
