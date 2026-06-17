import * as core from "@actions/core";
import * as github from "@actions/github";
import { AiClient, type ReviewResult } from "./ai";
import { annotateFile, renderDiff, type AnnotatedFile } from "./diff";
import {
  getHeadSha,
  getPrContext,
  listChangedFiles,
  matchesAnyGlob,
  postReview,
} from "./github";
import {
  DEFAULT_FULL_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  buildFullUserPrompt,
  buildUserPrompt,
} from "./prompt";
import { reportScanResults } from "./report";
import { annotateRepoFile, batchFiles, listRepoFiles } from "./repo";

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
  const mode = (core.getInput("mode") || "pr").toLowerCase();
  const systemPromptOverride = core.getInput("system-prompt");
  const maxFiles = Number.parseInt(core.getInput("max-files") || "50", 10);
  const exclude = parsePatterns(core.getInput("exclude"));
  const failOnFindings = core.getInput("fail-on-findings") === "true";
  const maxRetries = Number.parseInt(core.getInput("max-retries") || "5", 10);
  const temperature = parseTemperature(core.getInput("temperature"));

  if (mode !== "pr" && mode !== "full") {
    core.setFailed(`Modo inválido: "${mode}". Use "pr" ou "full".`);
    return;
  }

  if (mode === "full") {
    await runFullScan({
      apiToken,
      baseUrl,
      model,
      systemPromptOverride,
      maxFiles,
      exclude,
      failOnFindings,
      maxRetries,
      temperature,
    });
    return;
  }

  await runPrReview({
    apiToken,
    baseUrl,
    model,
    githubToken,
    systemPromptOverride,
    maxFiles,
    exclude,
    failOnFindings,
    maxRetries,
    temperature,
  });
}

/**
 * Faz o parse do input `temperature`. Vazio retorna undefined (campo não enviado,
 * usa o default do modelo). Um número fora da faixa 0-2 é rejeitado.
 */
function parseTemperature(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(`Temperatura inválida: "${raw}". Use um número entre 0 e 2, ou deixe vazio.`);
  }
  return value;
}

interface CommonOpts {
  apiToken: string;
  baseUrl: string;
  model: string;
  systemPromptOverride: string;
  maxFiles: number;
  exclude: string[];
  failOnFindings: boolean;
  maxRetries: number;
  /** Temperatura de amostragem; undefined = usa o default do modelo. */
  temperature?: number;
}

/** Loga uma re-tentativa da chamada à IA no log da action. */
function logRetry(attempt: number, status: number, waitMs: number): void {
  core.warning(
    `IA respondeu ${status}; re-tentando (tentativa ${attempt}) em ${Math.round(
      waitMs / 1000
    )}s...`
  );
}

async function runPrReview(
  opts: CommonOpts & { githubToken: string }
): Promise<void> {
  const ctx = getPrContext();
  if (!ctx) {
    core.info("Nenhum pull request encontrado no contexto do evento; nada a revisar.");
    core.setOutput("findings-count", "0");
    return;
  }

  const octokit = github.getOctokit(opts.githubToken);

  core.info(`Buscando arquivos alterados do PR #${ctx.prNumber}...`);
  const changed = await listChangedFiles(octokit, ctx, opts.exclude, opts.maxFiles);
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

  core.info(`Enviando ${annotated.length} arquivo(s) para o modelo ${opts.model} revisar...`);
  const client = new AiClient({
    baseUrl: opts.baseUrl,
    token: opts.apiToken,
    model: opts.model,
    systemPrompt: opts.systemPromptOverride || DEFAULT_SYSTEM_PROMPT,
    temperature: opts.temperature,
    maxRetries: opts.maxRetries,
    onRetry: logRetry,
  });
  const result = await client.review(buildUserPrompt(renderDiff(annotated)));

  core.info(`A IA retornou ${result.findings.length} achado(s).`);
  core.setOutput("findings-count", String(result.findings.length));

  const headSha = await getHeadSha(octokit, ctx);
  await postReview(octokit, ctx, headSha, result, validLinesByFile);
  core.info("Revisão postada no pull request.");

  if (opts.failOnFindings && result.findings.length > 0) {
    core.setFailed(`${result.findings.length} achado(s) reportado(s) pela revisão da IA.`);
  }
}

async function runFullScan(opts: CommonOpts): Promise<void> {
  const maxFileBytes = Number.parseInt(core.getInput("max-file-bytes") || "100000", 10);
  const maxCharsPerRequest = Number.parseInt(
    core.getInput("max-chars-per-request") || "100000",
    10
  );
  const include = parsePatterns(core.getInput("include"));
  const reportPath = core.getInput("report-path") || "scaia-report.md";

  core.info("Listando arquivos versionados do repositório...");
  let files: string[];
  try {
    files = listRepoFiles();
  } catch (err) {
    core.setFailed(
      `Falha ao listar arquivos com "git ls-files". O repositório foi clonado com actions/checkout? ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  const selected = files
    .filter((p) => include.length === 0 || matchesAnyGlob(p, include))
    .filter((p) => !matchesAnyGlob(p, opts.exclude))
    .slice(0, opts.maxFiles);

  const annotated: AnnotatedFile[] = [];
  for (const path of selected) {
    const a = annotateRepoFile(path, maxFileBytes);
    if (a) annotated.push(a);
  }
  if (annotated.length === 0) {
    core.info("Nenhum arquivo de texto elegível encontrado para escanear.");
    core.setOutput("findings-count", "0");
    return;
  }

  const batches = batchFiles(annotated, maxCharsPerRequest);
  core.info(
    `Escaneando ${annotated.length} arquivo(s) em ${batches.length} lote(s) com o modelo ${opts.model}...`
  );

  const client = new AiClient({
    baseUrl: opts.baseUrl,
    token: opts.apiToken,
    model: opts.model,
    systemPrompt: opts.systemPromptOverride || DEFAULT_FULL_SYSTEM_PROMPT,
    temperature: opts.temperature,
    maxRetries: opts.maxRetries,
    onRetry: logRetry,
  });

  const merged: ReviewResult = { summary: "", findings: [] };
  const summaries: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    core.info(`Revisando lote ${i + 1}/${batches.length}...`);
    const result = await client.review(buildFullUserPrompt(renderDiff(batches[i])));
    merged.findings.push(...result.findings);
    if (result.summary) summaries.push(result.summary);
  }
  merged.summary = summaries.join(" ");

  core.info(`A IA retornou ${merged.findings.length} achado(s).`);
  core.setOutput("findings-count", String(merged.findings.length));

  await reportScanResults(merged, reportPath);
  core.setOutput("report-path", reportPath);
  core.info(`Relatório do scan gerado em ${reportPath} e no Job Summary.`);

  if (opts.failOnFindings && merged.findings.length > 0) {
    core.setFailed(`${merged.findings.length} achado(s) reportado(s) pela revisão da IA.`);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
