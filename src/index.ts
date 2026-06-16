import * as core from "@actions/core";
import * as github from "@actions/github";
import { AiClient } from "./ai";
import { annotateFile, renderDiff, type AnnotatedFile } from "./diff";
import {
  getHeadSha,
  getPrContext,
  listChangedFiles,
  postReview,
} from "./github";

function parsePatterns(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run(): Promise<void> {
  const apiToken = core.getInput("api-token", { required: true });
  const baseUrl = core.getInput("api-base-url") || "https://api.openai.com/v1";
  const model = core.getInput("model", { required: true });
  const githubToken = core.getInput("github-token", { required: true });
  const systemPrompt = core.getInput("system-prompt");
  const maxFiles = Number.parseInt(core.getInput("max-files") || "50", 10);
  const exclude = parsePatterns(core.getInput("exclude"));
  const failOnFindings = core.getInput("fail-on-findings") === "true";

  const ctx = getPrContext();
  if (!ctx) {
    core.info("Nenhum pull request encontrado no contexto do evento; nada a revisar.");
    core.setOutput("findings-count", "0");
    return;
  }

  const octokit = github.getOctokit(githubToken);

  core.info(`Buscando arquivos alterados do PR #${ctx.prNumber}...`);
  const changed = await listChangedFiles(octokit, ctx, exclude, maxFiles);
  if (changed.length === 0) {
    core.info("Nenhum arquivo revisável neste PR.");
    core.setOutput("findings-count", "0");
    return;
  }

  const annotated: AnnotatedFile[] = [];
  for (const file of changed) {
    const a = annotateFile(file);
    if (a) annotated.push(a);
  }
  if (annotated.length === 0) {
    core.info("Nenhum diff disponível para revisar (arquivos binários ou grandes demais).");
    core.setOutput("findings-count", "0");
    return;
  }

  const validLinesByFile = new Map(
    annotated.map((f) => [f.path, f.validLines] as const)
  );

  core.info(`Enviando ${annotated.length} arquivo(s) para o modelo ${model} revisar...`);
  const client = new AiClient({ baseUrl, token: apiToken, model, systemPrompt });
  const result = await client.review(renderDiff(annotated));

  core.info(`A IA retornou ${result.findings.length} achado(s).`);
  core.setOutput("findings-count", String(result.findings.length));

  const headSha = await getHeadSha(octokit, ctx);
  await postReview(octokit, ctx, headSha, result, validLinesByFile);
  core.info("Revisão postada no pull request.");

  if (failOnFindings && result.findings.length > 0) {
    core.setFailed(`${result.findings.length} achado(s) reportado(s) pela revisão da IA.`);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
