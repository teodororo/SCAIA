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
