# SCAIA — Action de Revisão de Código por IA

Uma GitHub Action reutilizável que roda uma revisão por IA no seu código. Quem
usa traz **o próprio token de IA** e aponta a action para **qualquer endpoint
Chat Completions compatível com a OpenAI** (OpenAI, OpenRouter, um proxy do
Claude, um modelo self-hosted, etc.).

Ela tem dois modos, controlados pelo input `mode`:

- **`pr`** (padrão): revisa apenas o diff de um pull request e posta os achados
  como **comentários inline** no PR.
- **`full`**: escaneia o **repositório inteiro** e gera um **relatório Markdown**
  (arquivo no workspace, pronto para virar artifact) além de um **Job Summary**.

## Como funciona

### Modo `pr`

1. Em um evento de `pull_request`, a action lista os arquivos alterados e seus diffs.
2. Cada diff é anotado com os números de linha do lado novo e enviado ao seu modelo.
3. O modelo retorna achados estruturados em JSON (caminho, linha, severidade, comentário).
4. Os achados são postados como comentários inline; o que ficar fora do alcance do
   diff é incorporado ao resumo da revisão, para que nada se perca.

### Modo `full`

1. Em qualquer evento (`push`, `workflow_dispatch`, `schedule`, …), com o repo
   já clonado por `actions/checkout`, a action lista os arquivos versionados
   (`git ls-files`) e aplica os filtros `include`/`exclude`.
2. Cada arquivo é anotado com seus números de linha e enviado ao modelo em lotes,
   respeitando o orçamento de `max-chars-per-request`.
3. Os achados são gravados em um relatório Markdown (`report-path`, agrupado por
   severidade) e também no Job Summary do workflow. Suba o relatório como artifact
   com `actions/upload-artifact` usando o output `report-path`.

## Uso

```yaml
name: Revisão de Código por IA
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: teodororo/SCAIA@v1
        with:
          api-token: ${{ secrets.AI_API_TOKEN }}
          model: gpt-4o
          # api-base-url: https://api.openai.com/v1   # padrão
```

### Usando outro provedor

```yaml
      - uses: teodororo/SCAIA@v1
        with:
          api-token: ${{ secrets.OPENROUTER_KEY }}
          api-base-url: https://openrouter.ai/api/v1
          model: anthropic/claude-3.5-sonnet
```

### Escaneando o repositório inteiro (modo `full`)

```yaml
name: Scan completo por IA
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1" # toda segunda às 06:00 UTC

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # obrigatório no modo full
      - uses: teodororo/SCAIA@v1
        with:
          mode: full
          api-token: ${{ secrets.AI_API_TOKEN }}
          model: gpt-4o
          include: "src/**" # opcional; vazio = todos os arquivos versionados
          exclude: "**/*.lock,dist/**"
        id: scaia
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: scaia-report
          path: ${{ steps.scaia.outputs.report-path }}
```

## Inputs

| Input                   | Obrigatório | Padrão                      | Descrição                                                                                 |
| ----------------------- | ----------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `api-token`             | sim         | —                           | A chave de API do chamador para o provedor de IA.                                         |
| `model`                 | sim         | —                           | Id do modelo a usar.                                                                      |
| `mode`                  | não         | `pr`                        | `pr` revisa o diff do PR; `full` escaneia o repositório inteiro (exige `actions/checkout`). |
| `api-base-url`          | não         | `https://api.openai.com/v1` | URL base do endpoint Chat Completions compatível com a OpenAI.                            |
| `github-token`          | não         | `${{ github.token }}`       | Token usado para ler o PR e postar comentários (modo `pr`).                               |
| `system-prompt`         | não         | prompt de revisor embutido  | Override do prompt de sistema do revisor.                                                 |
| `max-files`             | não         | `50`                        | Limite de arquivos enviados à IA.                                                         |
| `include`               | não         | —                           | (modo `full`) Globs de arquivos a incluir. Vazio = todos os versionados.                  |
| `exclude`               | não         | —                           | Globs de arquivos a ignorar, separados por vírgula/quebra de linha (`*`, `**`).          |
| `max-file-bytes`        | não         | `100000`                    | (modo `full`) Ignora arquivos maiores que este tamanho em bytes.                         |
| `max-chars-per-request` | não         | `100000`                    | (modo `full`) Orçamento de caracteres por requisição à IA (envio em lotes).             |
| `report-path`           | não         | `scaia-report.md`           | (modo `full`) Caminho do arquivo Markdown de relatório gerado.                           |
| `fail-on-findings`      | não         | `false`                     | Falha o job quando a IA reporta qualquer achado.                                          |

## Outputs

| Output           | Descrição                                              |
| ---------------- | ------------------------------------------------------ |
| `findings-count` | Número de achados produzidos pela IA.                  |
| `report-path`    | (modo `full`) Caminho do arquivo de relatório gerado. |

## Permissões

- Modo `pr`: o job precisa de `pull-requests: write` para postar a revisão e
  `contents: read` para buscar os diffs.
- Modo `full`: basta `contents: read`, e o repositório precisa ter sido clonado
  com `actions/checkout` antes da action.

## Desenvolvimento

```bash
npm install
npm run typecheck   # checagem de tipos com o tsc
npm run build       # empacota em dist/ com o ncc
```

O `dist/index.js` empacotado precisa ser commitado — o GitHub Actions o executa
diretamente.
