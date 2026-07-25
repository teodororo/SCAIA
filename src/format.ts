/**
 * Formatação compartilhada dos achados em Markdown, usada tanto nos comentários
 * do pull request quanto no relatório do modo "full".
 */

import type { Finding } from "./ai";

export const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  critical: "🔴 Crítico",
  high: "🟠 Alto",
  medium: "🟡 Médio",
  low: "🔵 Baixo",
};

export const SEVERITY_ORDER: Finding["severity"][] = [
  "critical",
  "high",
  "medium",
  "low",
];

/** Formata a confiança (0–1) como porcentagem inteira, ex.: "91%". */
export function confidencePct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Linha de cabeçalho de um achado: severidade, título, confiança e CWE. */
export function findingTitle(f: Finding): string {
  const parts = [`${SEVERITY_LABEL[f.severity]} — **${f.vulnerability}**`];
  parts.push(`(confiança ${confidencePct(f.confidence)})`);
  if (f.cwe) parts.push(`\`${f.cwe}\``);
  return parts.join(" ");
}

export interface RenderOptions {
  /** Adiciona o caminho e a linha (útil no relatório; inline é implícito). */
  withLocation?: boolean;
  /**
   * Renderiza `fixCode` como bloco ```suggestion do GitHub (botão "Commit
   * suggestion"). Só faça isso em comentários ancorados na(s) linha(s) certa(s).
   */
  asSuggestion?: boolean;
}

/** Renderiza um achado completo em Markdown. */
export function renderFinding(f: Finding, opts: RenderOptions = {}): string {
  const lines: string[] = [findingTitle(f)];
  if (opts.withLocation) lines.push("", `\`${f.path}:${f.line}\``);
  lines.push("", f.explanation);
  if (f.evidence) {
    lines.push("", "**Evidência:**", "```", f.evidence, "```");
  }
  if (f.fixCode && opts.asSuggestion) {
    if (f.fix) lines.push("", `**Correção:** ${f.fix}`);
    lines.push("", "```suggestion", f.fixCode, "```");
  } else if (f.fixCode) {
    if (f.fix) lines.push("", `**Correção:** ${f.fix}`);
    lines.push("", "```", f.fixCode, "```");
  } else if (f.fix) {
    lines.push("", `**Correção:** ${f.fix}`);
  }
  return lines.join("\n");
}

/** Recuo (espaços/tabs iniciais) de uma linha. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Reindenta o `fix_code` do modelo para o recuo da linha que ele substitui.
 *
 * O modelo costuma devolver a correção na coluna 0 mesmo quando a linha original
 * está aninhada, e o bloco ```suggestion do GitHub troca a linha inteira —
 * incluindo o recuo. Aplicar a sugestão como veio quebra o arquivo em linguagens
 * sensíveis a indentação.
 *
 * A correção é um deslocamento uniforme: calcula-se o recuo base do próprio
 * `fixCode` (o da sua primeira linha não vazia) e desloca-se o bloco inteiro até
 * o recuo alvo, preservando a estrutura relativa entre as linhas. Se o bloco já
 * chega com o recuo certo, nada muda. Blocos internamente inconsistentes não são
 * consertados — apenas deslocados.
 */
export function reindentFix(fixCode: string, targetLine: string): string {
  const lines = fixCode.split("\n");
  const primeira = lines.find((l) => l.trim() !== "");
  if (primeira === undefined) return fixCode;

  const base = indentOf(primeira);
  const alvo = indentOf(targetLine);
  if (base === alvo) return fixCode;

  // Só é seguro remover o recuo base se todas as linhas com conteúdo o tiverem.
  const podeRemover =
    base === "" || lines.every((l) => l.trim() === "" || l.startsWith(base));
  if (!podeRemover) return fixCode;

  return lines
    .map((l) => (l.trim() === "" ? l : alvo + l.slice(base.length)))
    .join("\n");
}
