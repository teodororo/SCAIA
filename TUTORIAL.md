# Tutorial Rápido — SCAIA

Revisão de código por IA no seu repositório em 3 passos. Você usa **a sua própria
chave de IA** (OpenAI, OpenRouter, Claude via proxy, etc.).

Escolha um modo:

- **`pr`** — comenta inline nos pull requests (uso no dia a dia).
- **`full`** — escaneia o repo inteiro e gera um relatório (auditoria pontual).

---

## Passo 1 — Adicione sua chave de IA como secret

No seu repositório no GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

- **Name:** `AI_API_TOKEN`
- **Secret:** sua chave de API

---

## Passo 2 — Crie o workflow

### Opção A — Revisar Pull Requests (modo `pr`)

Crie `.github/workflows/scaia.yml`:

```yaml
name: Revisão por IA
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # necessário pra comentar no PR

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: teodororo/SCAIA@v1
        with:
          api-token: ${{ secrets.AI_API_TOKEN }}
          model: gpt-4o
```

### Opção B — Escanear o repo inteiro (modo `full`)

Crie `.github/workflows/scaia-scan.yml`:

```yaml
name: Scan Completo por IA
on:
  workflow_dispatch:     # botão "Run workflow" manual

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4      # obrigatório no modo full
      - id: scaia
        uses: teodororo/SCAIA@v1
        with:
          mode: full
          api-token: ${{ secrets.AI_API_TOKEN }}
          model: gpt-4o
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: scaia-report
          path: ${{ steps.scaia.outputs.report-path }}
```

---

## Passo 3 — Rode

- **Modo `pr`:** abra um pull request → a revisão roda e comenta sozinha.
- **Modo `full`:** aba **Actions** → "Scan Completo por IA" → **Run workflow**.
  Ao terminar, baixe o artifact `scaia-report` e veja o **Job Summary**.

---

## Usando outro provedor (não-OpenAI)

Aponte `api-base-url` pro endpoint compatível com OpenAI e troque o `model`:

```yaml
      - uses: teodororo/SCAIA@v1
        with:
          api-token: ${{ secrets.AI_API_TOKEN }}
          api-base-url: https://openrouter.ai/api/v1
          model: anthropic/claude-3.5-sonnet
```

---

## Ajustes úteis (opcionais)

| Quero...                                  | Use                                              |
| ----------------------------------------- | ------------------------------------------------ |
| Escanear só uma pasta (modo `full`)       | `include: "src/**"`                              |
| Ignorar arquivos                          | `exclude: "**/*.lock,dist/**,**/node_modules/**"`|
| Falhar o job se houver achados            | `fail-on-findings: "true"`                       |
| Trocar o nome do relatório                | `report-path: meu-relatorio.md`                  |

> Lista completa de inputs no [README](./README.md).
