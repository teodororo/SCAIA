import * as github from "@actions/github";
import type { ChangedFile } from "./diff";
import type { Finding, ReviewResult } from "./ai";

type Octokit = ReturnType<typeof github.getOctokit>;

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Resolve o contexto do pull request a partir do payload do evento do workflow. */
export function getPrContext(): PrContext | null {
  const { payload, repo } = github.context;
  const prNumber = payload.pull_request?.number;
  if (!prNumber) return null;
  return { owner: repo.owner, repo: repo.repo, prNumber };
}

/** Lista os arquivos alterados no PR, opcionalmente filtrando por globs de exclusão e um limite. */
export async function listChangedFiles(
  octokit: Octokit,
  ctx: PrContext,
  exclude: string[],
  maxFiles: number
): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    per_page: 100,
  });

  const filtered = files
    .filter((f) => f.status !== "removed")
    .filter((f) => !isExcluded(f.filename, exclude))
    .map((f) => ({ path: f.filename, patch: f.patch, status: f.status }));

  return filtered.slice(0, maxFiles);
}

/** O commit ao qual os comentários da revisão devem ser anexados (HEAD do PR). */
export async function getHeadSha(
  octokit: Octokit,
  ctx: PrContext
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  return data.head.sha;
}

/**
 * Posta a revisão. Achados cuja linha é um alvo válido de comentário viram
 * comentários inline; os demais são incorporados ao corpo do resumo para que
 * nada se perca.
 */
export async function postReview(
  octokit: Octokit,
  ctx: PrContext,
  commitId: string,
  result: ReviewResult,
  validLinesByFile: Map<string, Set<number>>
): Promise<void> {
  const inline: { path: string; line: number; side: "RIGHT"; body: string }[] = [];
  const orphaned: Finding[] = [];

  for (const f of result.findings) {
    const valid = validLinesByFile.get(f.path);
    if (valid && valid.has(f.line)) {
      inline.push({
        path: f.path,
        line: f.line,
        side: "RIGHT",
        body: `**${severityLabel(f.severity)}** ${f.comment}`,
      });
    } else {
      orphaned.push(f);
    }
  }

  const body = buildSummaryBody(result, orphaned, inline.length);

  await octokit.rest.pulls.createReview({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: inline,
  });
}

function buildSummaryBody(
  result: ReviewResult,
  orphaned: Finding[],
  inlineCount: number
): string {
  const lines: string[] = ["## 🤖 Revisão do SCAIA"];
  if (result.summary) lines.push("", result.summary);

  const total = result.findings.length;
  if (total === 0) {
    lines.push("", "Nenhum problema encontrado nas linhas alteradas. ✅");
    return lines.join("\n");
  }

  lines.push("", `Reportado(s) ${total} achado(s); ${inlineCount} postado(s) inline.`);

  if (orphaned.length > 0) {
    lines.push("", "### Achados fora do alcance do diff");
    for (const f of orphaned) {
      lines.push(
        `- **${severityLabel(f.severity)}** \`${f.path}:${f.line}\` — ${f.comment}`
      );
    }
  }

  return lines.join("\n");
}

function severityLabel(sev: Finding["severity"]): string {
  switch (sev) {
    case "critical":
      return "🔴 Crítico:";
    case "high":
      return "🟠 Alto:";
    case "medium":
      return "🟡 Médio:";
    case "low":
      return "🔵 Baixo:";
  }
}

/** Matcher de glob bem pequeno, com suporte a segmentos "*" e "**". */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, path));
}

function isExcluded(path: string, patterns: string[]): boolean {
  return matchesAnyGlob(path, patterns);
}

function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split(/(\*\*|\*)/)
        .map((part) => {
          if (part === "**") return ".*";
          if (part === "*") return "[^/]*";
          return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        })
        .join("") +
      "$"
  );
  return re.test(path);
}
