/**
 * Funções auxiliares para trabalhar com os diffs no formato unificado retornados
 * pela API do GitHub "listar arquivos do pull request".
 */

export interface ChangedFile {
  path: string;
  patch?: string;
  status: string;
}

export interface AnnotatedFile {
  path: string;
  /** Diff anotado com os números de linha do lado novo, pronto para o modelo. */
  annotated: string;
  /** Conjunto de números de linha válidos no lado novo que um comentário pode alvejar. */
  validLines: Set<number>;
}

/**
 * Faz o parse de um cabeçalho de hunk como "@@ -12,7 +34,9 @@".
 * Retorna a linha inicial no lado novo (direito), ou null se não casar.
 */
function parseHunkStart(line: string): number | null {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/**
 * Anota o patch de um arquivo com os números de linha do lado novo, para o modelo
 * conseguir referenciar linhas exatas, e coleta o conjunto de números de linha que
 * são alvos válidos de comentário (linhas adicionadas e linhas de contexto no lado novo).
 */
export function annotateFile(file: ChangedFile): AnnotatedFile | null {
  if (!file.patch) return null;

  const validLines = new Set<number>();
  const out: string[] = [];
  let newLine = 0;

  for (const raw of file.patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const start = parseHunkStart(raw);
      if (start !== null) newLine = start;
      out.push(raw);
      continue;
    }

    if (raw.startsWith("-")) {
      // Linha removida: existe só no lado antigo, sem número no lado novo.
      out.push(`      ${raw}`);
      continue;
    }

    if (raw.startsWith("+")) {
      validLines.add(newLine);
      out.push(`${String(newLine).padStart(5, " ")}: ${raw.slice(1)}`);
      newLine += 1;
      continue;
    }

    // Linha de contexto (começa com espaço) ou "\ No newline at end of file".
    if (raw.startsWith("\\")) {
      out.push(raw);
      continue;
    }
    validLines.add(newLine);
    out.push(`${String(newLine).padStart(5, " ")}: ${raw.slice(1)}`);
    newLine += 1;
  }

  return { path: file.path, annotated: out.join("\n"), validLines };
}

/** Monta o texto completo do diff exibido ao modelo a partir dos arquivos anotados. */
export function renderDiff(files: AnnotatedFile[]): string {
  return files
    .map((f) => `### Arquivo: ${f.path}\n${f.annotated}`)
    .join("\n\n");
}
