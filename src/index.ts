import * as core from "@actions/core";
import * as github from "@actions/github";
import { AiClient, serializeFindings, type ReviewResult } from "./ai";
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
  SECOND_OPINION_SYSTEM_PROMPT,
  buildFullUserPrompt,
  buildSecondOpinionUserPrompt,
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
  const minConfidence = parseMinConfidence(core.getInput("min-confidence"));

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
      minConfidence,
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
    minConfidence,
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

/**
 * Faz o parse do input `min-confidence`. Vazio usa o default 0.8. Rejeita
 * valores fora da faixa 0-1.
 */
function parseMinConfidence(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0.8;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`min-confidence inválido: "${raw}". Use um número entre 0 e 1.`);
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
  /** Confiança mínima (0-1) para um achado sobreviver ao filtro final. */
  minConfidence: number;
}

/**
 * Segunda chamada à IA: reenvia o mesmo material da primeira revisão junto com
 * os achados que ela produziu, e mantém apenas os que sobrevivem a uma auditoria
 * cética. O critério é assimétrico por desenho — qualquer dúvida descarta o
 * achado —, então esta passagem só reduz o conjunto, nunca o amplia.
 *
 * Roda sempre que houver candidatos. Se a chamada falhar, o erro sobe: publicar
 * os candidatos sem auditoria seria pior que falhar visivelmente.
 */
async function segundaOpiniao(
  client: AiClient,
  diffText: string,
  candidatos: ReviewResult["findings"]
): Promise<ReviewResult> {
  if (candidatos.length === 0) return { summary: "", findings: candidatos };

  core.info(`Auditando ${candidatos.length} achado(s) candidato(s) em uma segunda chamada...`);
  const auditado = await client.review(
    buildSecondOpinionUserPrompt(diffText, serializeFindings(candidatos)),
    SECOND_OPINION_SYSTEM_PROMPT
  );

  // A segunda opinião não pode inventar achados: mantém-se apenas o que casa
  // com um candidato original (mesmo arquivo e mesma linha).
  const chaves = new Set(candidatos.map((f) => `${f.path}:${f.line}`));
  const confirmados = auditado.findings.filter((f) => chaves.has(`${f.path}:${f.line}`));

  // Os dois motivos de exclusão são contados em separado: um achado "não
  // devolvido" foi julgado falso positivo pela auditoria; um achado "fora da
  // lista" foi barrado pelo guard por não corresponder a nenhum candidato.
  const naoDevolvidos = candidatos.length - auditado.findings.length;
  const foraDaLista = auditado.findings.length - confirmados.length;
  core.info(
    `${confirmados.length} de ${candidatos.length} achado(s) confirmado(s) na auditoria.`
  );
  if (naoDevolvidos > 0) {
    core.info(`  ${naoDevolvidos} descartado(s) pela auditoria como falso positivo.`);
  }
  if (foraDaLista > 0) {
    core.warning(
      `  ${foraDaLista} achado(s) da auditoria não correspondem a nenhum candidato ` +
        `(path:line divergente) e foram bloqueados pelo guard.`
    );
  }

  return { summary: auditado.summary, findings: confirmados };
}

/** Descarta os achados cuja confiança reportada fica abaixo do mínimo configurado. */
function filterByConfidence(
  candidates: ReviewResult["findings"],
  minConfidence: number
): ReviewResult["findings"] {
  return candidates.filter((f) => f.confidence >= minConfidence);
}

/**
 * Separa vulnerabilidades de recomendações preventivas, segundo a classificação
 * declarada pelo próprio modelo em `finding_type`.
 */
function splitByFindingType(findings: ReviewResult["findings"]): {
  vulnerabilities: ReviewResult["findings"];
  hardening: ReviewResult["findings"];
} {
  return {
    vulnerabilities: findings.filter((f) => f.findingType === "vulnerability"),
    hardening: findings.filter((f) => f.findingType === "hardening"),
  };
}

/**
 * Descarta os achados classificados como "hardening" pelo próprio modelo. Eles
 * saem do fluxo no momento da classificação: não são auditados nem publicados,
 * porque a ferramenta reporta vulnerabilidade, não recomendação preventiva.
 *
 * Os títulos descartados vão para o log da action — sem isso, um achado real
 * rebaixado por engano some sem deixar rastro algum.
 */
function descartarHardening(
  findings: ReviewResult["findings"]
): ReviewResult["findings"] {
  const { vulnerabilities, hardening } = splitByFindingType(findings);
  if (hardening.length > 0) {
    core.info(
      `${hardening.length} achado(s) descartado(s) por serem hardening, não vulnerabilidade:`
    );
    for (const f of hardening) {
      core.info(`  - ${f.vulnerability} (${f.path}:${f.line})`);
    }
  }
  return vulnerabilities;
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
  const lineTextByFile = new Map(
    annotated.map((f) => [f.path, f.lineText] as const)
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
  const diffText = renderDiff(annotated);
  const result = await client.review(buildUserPrompt(diffText));
  core.info(`A IA retornou ${result.findings.length} achado(s) candidato(s).`);

  const vulnerabilidades = descartarHardening(result.findings);
  const auditoria = await segundaOpiniao(client, diffText, vulnerabilidades);
  // O resumo publicado passa a ser o da auditoria: manter o da primeira revisão
  // faria o corpo do PR descrever vulnerabilidades que foram descartadas.
  if (auditoria.summary) result.summary = auditoria.summary;
  result.findings = filterByConfidence(auditoria.findings, opts.minConfidence);
  core.info(`${result.findings.length} achado(s) após o filtro de confiança mínima.`);
  core.setOutput("findings-count", String(result.findings.length));

  const headSha = await getHeadSha(octokit, ctx);
  await postReview(octokit, ctx, headSha, result, validLinesByFile, lineTextByFile);
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
    const batchText = renderDiff(batches[i]);
    const result = await client.review(buildFullUserPrompt(batchText));
    const auditoria = await segundaOpiniao(
      client,
      batchText,
      descartarHardening(result.findings)
    );
    merged.findings.push(...filterByConfidence(auditoria.findings, opts.minConfidence));
    const resumoLote = auditoria.summary || result.summary;
    if (resumoLote) summaries.push(resumoLote);
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
