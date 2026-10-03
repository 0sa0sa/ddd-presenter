import { createHash } from "node:crypto";

/**
 * - generated: owned by the generator; rewritten on every run, hand edits are detected.
 * - scaffold: written once if missing, then owned by the customer; never overwritten.
 */
export type Ownership = "generated" | "scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
  ownership: Ownership;
}

export interface Manifest {
  generator: string;
  generator_version: string;
  schema_version: number;
  project: string;
  model_sha256: string;
  files: { path: string; sha256: string }[];
  scaffold: string[];
  /** Generated files the model no longer produces, kept on disk until pruned. */
  stale?: { path: string; sha256: string }[];
}

export interface GenerationOutput {
  files: GeneratedFile[];
  manifest: Manifest;
  manifestPath: string;
  /** Tests directory of the model (`generation.tests_dir`); generated tests live under `<testsDir>/generated/`. */
  testsDir: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Normalizes line endings so the model hash does not depend on the checkout platform. */
export function modelHash(modelText: string): string {
  return sha256(modelText.replace(/\r\n/g, "\n"));
}
