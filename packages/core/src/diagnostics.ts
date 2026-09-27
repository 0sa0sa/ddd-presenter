export type Severity = "error" | "warning" | "info";
export type Path = (string | number)[];

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. `unknown-type`. */
  code: string;
  message: string;
  /** Path into the YAML document, e.g. ["contexts", 0, "aggregates", 1, "fields", 2, "type"]. */
  path: Path;
  /** Human-readable element name, e.g. "CleaningStaff › CleaningStaffInvitation › accept". */
  element?: string;
  hint?: string;
  line?: number;
  column?: number;
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  error(code: string, message: string, path: Path, extra: Partial<Diagnostic> = {}): void {
    this.items.push({ severity: "error", code, message, path, ...extra });
  }

  warning(code: string, message: string, path: Path, extra: Partial<Diagnostic> = {}): void {
    this.items.push({ severity: "warning", code, message, path, ...extra });
  }

  info(code: string, message: string, path: Path, extra: Partial<Diagnostic> = {}): void {
    this.items.push({ severity: "info", code, message, path, ...extra });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Deterministic ordering so that Web and CLI print identical results. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

export function formatPath(path: Path): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join("");
}

export function formatDiagnostic(d: Diagnostic, file = "model"): string {
  const loc = d.line ? `${file}:${d.line}:${d.column ?? 1}` : file;
  const where = d.element ? ` (${d.element})` : "";
  const hint = d.hint ? `\n    hint: ${d.hint}` : "";
  return `${loc}: ${d.severity} [${d.code}]${where} ${d.message}\n    at ${formatPath(d.path)}${hint}`;
}
