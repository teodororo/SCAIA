import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

export interface Finding {
  path: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  /** Título/tipo do problema, ex.: "SQL Injection". */
  vulnerability: string;
  /** Confiança do modelo no achado, de 0 a 1. */
  confidence: number;
  /** Explicação concisa do problema. */
  explanation: string;
  /** Trecho de código que evidencia o problema. */
  evidence?: string;
  /** Identificador CWE, ex.: "CWE-89". */
  cwe?: string;
  /** Correção concreta sugerida (descrição em texto). */
  fix?: string;
  /**
   * Código exato que substitui a(s) linha(s) indicada(s). Quando o achado está
   * sobre uma linha comentável do diff, vira um bloco ```suggestion do GitHub.
   */
  fixCode?: string;
  /**
   * Primeira linha substituída pelo `fixCode`, para sugestões multi-linha.
   * Quando ausente, a sugestão substitui apenas `line`.
   */
  fixStartLine?: number;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

export interface AiClientOptions {
  baseUrl: string;
  token: string;
  model: string;
  systemPrompt?: string;
  /** Máximo de re-tentativas em respostas 429/5xx. Padrão: 5. */
  maxRetries?: number;
  /** Chamado antes de cada nova tentativa, para fins de log. */
  onRetry?: (attempt: number, status: number, waitMs: number) => void;
}

/** Pausa a execução por `ms` milissegundos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extrai, em milissegundos, quanto esperar antes de re-tentar uma resposta 429.
 * Considera o header `Retry-After` (segundos) e a dica "try again in Xs" que a
 * OpenAI inclui no corpo do erro. Retorna undefined quando não há sinal.
 */
function retryAfterMs(res: Response, body: string): number | undefined {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(body);
  if (m) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) return m[2].toLowerCase() === "ms" ? value : value * 1000;
  }
  return undefined;
}

/**
 * Cliente mínimo para qualquer endpoint /chat/completions compatível com a OpenAI.
 * Usa o fetch global disponível no Node 20.
 */
export class AiClient {
  private readonly endpoint: string;

  constructor(private readonly opts: AiClientOptions) {
    const base = opts.baseUrl.replace(/\/+$/, "");
    this.endpoint = `${base}/chat/completions`;
  }

  async review(userContent: string): Promise<ReviewResult> {
    const body = {
      model: this.opts.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: this.opts.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    };

    const data = (await this.fetchWithRetry(body)) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("A resposta da IA não continha nenhum conteúdo.");
    }

    return parseReview(content);
  }

  /**
   * Faz o POST para o endpoint de chat, re-tentando em 429 (rate limit) e 5xx
   * com backoff exponencial. Em 429, respeita o tempo de espera sugerido pela
   * API (header `Retry-After` ou a dica no corpo). Retorna o JSON da resposta.
   */
  private async fetchWithRetry(body: unknown): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 5;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return res.json();

      const text = await res.text().catch(() => "");
      lastError = `${res.status} ${res.statusText} ${text.slice(0, 500)}`;

      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt === maxRetries) break;

      // Espera o tempo sugerido pela API, ou backoff exponencial (1s, 2s, 4s...)
      // com 1s de folga em cima do hint para evitar reincidir na janela.
      const hinted = retryAfterMs(res, text);
      const backoff = 2 ** attempt * 1000;
      const waitMs = (hinted ?? backoff) + (hinted ? 1000 : 0);
      this.opts.onRetry?.(attempt + 1, res.status, waitMs);
      await sleep(waitMs);
    }

    throw new Error(`Requisição à IA falhou: ${lastError}`);
  }
}

/** Faz o parse da saída do modelo em um ReviewResult, tolerando fences de markdown perdidos. */
export function parseReview(content: string): ReviewResult {
  const cleaned = stripFences(content).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new Error(`A IA não retornou um JSON válido. Recebido: ${content.slice(0, 500)}`);
  }

  const obj = (raw ?? {}) as Record<string, unknown>;
  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: Finding[] = [];

  for (const item of findingsRaw) {
    const f = item as Record<string, unknown>;
    const path = typeof f.path === "string" ? f.path : "";
    const line = typeof f.line === "number" ? f.line : Number(f.line);
    // "explanation" é o campo novo; "comment" é aceito por compatibilidade.
    const explanation = str(f.explanation) || str(f.comment);
    if (!path || !Number.isFinite(line) || !explanation) continue;
    findings.push({
      path,
      line,
      severity: normalizeSeverity(f.severity),
      vulnerability: str(f.vulnerability) || str(f.title) || "Problema",
      confidence: normalizeConfidence(f.confidence),
      explanation,
      evidence: str(f.evidence) || undefined,
      cwe: normalizeCwe(f.cwe),
      fix: str(f.fix) || undefined,
      fixCode: str(f.fix_code) || undefined,
      fixStartLine: intOrUndefined(f.fix_start_line),
    });
  }

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings,
  };
}

/** Coage o valor para uma string limpa, retornando "" quando vazio/ausente. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Converte o valor em inteiro finito, ou undefined quando ausente/inválido. */
function intOrUndefined(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Normaliza a confiança para o intervalo [0, 1], aceitando 0–100 ou "91%". */
function normalizeConfidence(value: unknown): number {
  let n =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/%$/, ""));
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1) n = n / 100;
  return Math.min(1, Math.max(0, n));
}

/** Normaliza o CWE para o formato "CWE-89", ou undefined quando ausente. */
function normalizeCwe(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const m = /(\d+)/.exec(s);
  return m ? `CWE-${m[1]}` : s;
}

function normalizeSeverity(value: unknown): Finding["severity"] {
  const s = String(value).toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") {
    return s;
  }
  return "medium";
}

function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fenced ? fenced[1] : text;
}
