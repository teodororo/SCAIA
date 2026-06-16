import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

export interface Finding {
  path: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  comment: string;
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

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Requisição à IA falhou: ${res.status} ${res.statusText} ${text.slice(0, 500)}`
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("A resposta da IA não continha nenhum conteúdo.");
    }

    return parseReview(content);
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
    const comment = typeof f.comment === "string" ? f.comment : "";
    if (!path || !Number.isFinite(line) || !comment) continue;
    findings.push({
      path,
      line,
      severity: normalizeSeverity(f.severity),
      comment,
    });
  }

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings,
  };
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
