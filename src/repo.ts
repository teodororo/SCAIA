/**
 * Suporte ao modo "full": lê os arquivos versionados do repositório a partir do
 * checkout no runner e os prepara para a IA com numeração de linha, no mesmo
 * formato consumido por `renderDiff`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { AnnotatedFile } from "./diff";

/** Lista os arquivos versionados via `git ls-files`, respeitando o .gitignore. */
export function listRepoFiles(cwd?: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/**
 * Lê um arquivo do disco e o anota com números de linha (base 1). Retorna null
 * para arquivos grandes demais ou que parecem binários. Como é um arquivo
 * completo, toda linha é um alvo válido de comentário.
 */
export function annotateRepoFile(
  path: string,
  maxBytes: number
): AnnotatedFile | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size > maxBytes) return null;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Heurística simples para pular binários: presença de byte nulo.
  if (content.includes(String.fromCharCode(0))) return null;

  const validLines = new Set<number>();
  const out: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    validLines.add(lineNo);
    out.push(`${String(lineNo).padStart(5, " ")}: ${lines[i]}`);
  }

  return { path, annotated: out.join("\n"), validLines };
}

/**
 * Quebra os arquivos anotados em lotes cujo tamanho renderizado fica abaixo do
 * orçamento de caracteres, para que cada requisição à IA caiba no contexto.
 */
export function batchFiles(
  files: AnnotatedFile[],
  maxChars: number
): AnnotatedFile[][] {
  const batches: AnnotatedFile[][] = [];
  let current: AnnotatedFile[] = [];
  let currentChars = 0;

  for (const file of files) {
    const cost = file.annotated.length + file.path.length + 32;
    if (current.length > 0 && currentChars + cost > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += cost;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}
