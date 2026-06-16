# SCAIA — Action de Revisão de Código por IA

Uma GitHub Action reutilizável que roda uma revisão por IA nos diffs de pull
requests. Quem usa traz **o próprio token de IA** e aponta a action para
**qualquer endpoint Chat Completions compatível com a OpenAI** (OpenAI,
OpenRouter, um proxy do Claude, um modelo self-hosted, etc.). Os achados são
postados como **comentários inline** no PR.

## Como funciona

1. Em um evento de `pull_request`, a action lista os arquivos alterados e seus diffs.
2. Cada diff é anotado com os números de linha do lado novo e enviado ao seu modelo.
3. O modelo retorna achados estruturados em JSON (caminho, linha, severidade, comentário).
4. Os achados são postados como comentários inline; o que ficar fora do alcance do
   diff é incorporado ao resumo da revisão, para que nada se perca.

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

## Inputs

| Input              | Obrigatório | Padrão                      | Descrição                                                          |
| ------------------ | ----------- | --------------------------- | ----------------------------------------------------------------- |
| `api-token`        | sim         | —                           | A chave de API do chamador para o provedor de IA.                 |
| `model`            | sim         | —                           | Id do modelo a usar.                                              |
| `api-base-url`     | não         | `https://api.openai.com/v1` | URL base do endpoint Chat Completions compatível com a OpenAI.    |
| `github-token`     | não         | `${{ github.token }}`       | Token usado para ler o PR e postar comentários.                   |
| `system-prompt`    | não         | prompt de revisor embutido  | Override do prompt de sistema do revisor.                         |
| `max-files`        | não         | `50`                        | Limite de arquivos alterados enviados à IA.                       |
| `exclude`          | não         | —                           | Globs de arquivos a ignorar, separados por vírgula/quebra de linha (`*`, `**`). |
| `fail-on-findings` | não         | `false`                     | Falha o job quando a IA reporta qualquer achado.                  |

## Outputs

| Output           | Descrição                            |
| ---------------- | ------------------------------------ |
| `findings-count` | Número de achados produzidos pela IA. |

## Permissões

O job precisa de `pull-requests: write` para postar a revisão e `contents: read`
para buscar os diffs.

## Desenvolvimento

```bash
npm install
npm run typecheck   # checagem de tipos com o tsc
npm run build       # empacota em dist/ com o ncc
```

O `dist/index.js` empacotado precisa ser commitado — o GitHub Actions o executa
diretamente.
