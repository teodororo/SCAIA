/**
 * Saída do modo "full": como não há pull request para comentar, os achados são
 * escritos em um arquivo de relatório Markdown no workspace (que pode virar um
 * artifact do workflow) e resumidos no Job Summary.
 */

import { writeFileSync } from "node:fs";
import * as core from "@actions/core";
import type { ReviewResult } from "./ai";
import { SEVERITY_LABEL, SEVERITY_ORDER, renderFinding } from "./format";

/** Gera o relatório do scan: arquivo Markdown + Job Summary. */
export async function reportScanResults(
  result: ReviewResult,
  reportPath: string
): Promise<void> {
  const markdown = buildMarkdown(result);

  writeFileSync(reportPath, markdown, "utf8");
  core.info(`Relatório gravado em ${reportPath}`);

  await core.summary.addRaw(markdown).write();
}

/** Monta o corpo do relatório em Markdown, com achados agrupados por severidade. */
function buildMarkdown(result: ReviewResult): string {
  const lines: string[] = ["# 🤖 Revisão do SCAIA — repositório inteiro", ""];

  if (result.summary) lines.push(result.summary, "");

  const total = result.findings.length;
  if (total === 0) {
    lines.push("Nenhum problema encontrado. ✅");
    return lines.join("\n");
  }

  const counts = SEVERITY_ORDER.map(
    (sev) => `${SEVERITY_LABEL[sev]}: ${result.findings.filter((f) => f.severity === sev).length}`
  );
  lines.push(`**Total de achados: ${total}** (${counts.join(" · ")})`, "");

  for (const sev of SEVERITY_ORDER) {
    const group = result.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${SEVERITY_LABEL[sev]} (${group.length})`, "");
    for (const f of group) {
      lines.push(renderFinding(f, { withLocation: true }), "");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
