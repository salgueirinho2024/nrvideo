# Gerador de Treinamentos NR

Gera vídeos de treinamento de Normas Regulamentadoras (NRs) automaticamente:
você cola o texto da norma, e o pipeline gera roteiro (Gemini), narração
(TTS), slides (Satori) e monta o vídeo final (FFmpeg).

## Stack

- **Next.js 14** (App Router) — frontend + API routes
- **Inngest** — orquestra o pipeline em etapas duráveis (roteiro → assets → render)
- **Gemini API** — gera o roteiro (cenas com narração + texto de tela) a partir do texto da NR
- **msedge-tts** — narração em voz neural PT-BR (gratuito, via Microsoft Edge TTS)
- **Satori + resvg** — gera os slides (PNG 1920x1080) a partir de JSX
- **fluent-ffmpeg / ffmpeg-static** — monta cada cena (imagem + áudio) e concatena no vídeo final
- **Neon (Postgres) + Drizzle ORM** — persistência de projetos e cenas
- **Vercel Blob** — armazena áudios, slides e o vídeo final

## Estrutura

```
src/
  app/
    page.tsx                        # Home: formulário para colar o texto da NR
    layout.tsx
    projects/[id]/page.tsx          # Página de acompanhamento do projeto (polling)
    api/
      inngest/route.ts              # Handler do Inngest (serve as functions)
      projects/route.ts             # POST cria projeto + dispara o evento; GET lista
      projects/[id]/route.ts        # GET detalhes do projeto + cenas
      voices/route.ts               # GET lista de vozes disponíveis
  inngest/
    client.ts
    functions/generate-video.ts     # Pipeline principal (4 etapas via step.run)
  lib/
    gemini.ts       # Gera o roteiro (JSON) via API REST do Gemini
    tts.ts          # Narração (msedge-tts)
    slides.tsx       # Slides PNG (Satori + resvg)
    render.ts        # Monta os clipes e concatena (FFmpeg)
    storage.ts       # Upload para o Vercel Blob
    download.ts      # Baixa asset remoto para /tmp (necessário entre steps do Inngest)
  db/
    schema.ts         # projects, scenes, scriptLogs
    index.ts           # Cliente Drizzle (Neon HTTP)
public/fonts/Inter-Bold.woff   # Fonte usada nos slides
```

## Como funciona o pipeline (Inngest)

1. **generate-script**: chama o Gemini com o texto da NR, recebe um roteiro
   em JSON (título + cenas), grava as cenas no banco.
2. **generate-assets-scene-N** (uma etapa por cena): gera o áudio (TTS) e o
   slide (PNG) de cada cena, envia ambos para o Vercel Blob.
3. **render-and-upload-video**: baixa os assets de todas as cenas para
   `/tmp`, monta um clipe mp4 por cena (imagem + áudio) com FFmpeg, concatena
   tudo e envia o vídeo final para o Blob.
4. **finalize**: marca o projeto como `done` com a URL do vídeo.

Cada etapa é isolada via `step.run`, então se uma falhar o Inngest só
reexecuta aquela etapa (não o pipeline inteiro). Se todas as tentativas
falharem, `onFailure` marca o projeto como `error`.

## Configuração local

### 1. Instalar dependências

```bash
npm install
```

### 2. Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

```bash
cp .env.example .env.local
```

- `DATABASE_URL`: crie um banco gratuito em [neon.tech](https://neon.tech)
- `GEMINI_API_KEY`: gere em [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- `BLOB_READ_WRITE_TOKEN`: crie um Blob store na Vercel (Storage → Create →
  Blob) e copie o token, ou rode `vercel env pull` se o projeto já estiver
  linkado

### 3. Criar as tabelas no banco

```bash
npm run db:push
```

### 4. Rodar o Next.js e o Inngest Dev Server (em terminais separados)

```bash
npm run dev
```

```bash
npx inngest-cli dev
```

O Inngest Dev Server abre em `http://localhost:8288` e detecta
automaticamente as functions expostas em `http://localhost:3000/api/inngest`.

### 5. Acessar

Abra `http://localhost:3000`, cole o texto de uma NR e clique em "Gerar
vídeo". Acompanhe o progresso na página do projeto.

## Deploy (Vercel)

1. Suba o repositório e importe na Vercel.
2. Conecte um **Neon Postgres** e um **Blob Store** ao projeto (Storage tab)
   — isso preenche `DATABASE_URL` e `BLOB_READ_WRITE_TOKEN` automaticamente.
3. Adicione `GEMINI_API_KEY` nas variáveis de ambiente do projeto.
4. Instale a [integração do Inngest](https://vercel.com/integrations/inngest)
   (preenche `INNGEST_EVENT_KEY` e `INNGEST_SIGNING_KEY` e registra
   `/api/inngest` automaticamente).
5. Rode as migrations contra o banco de produção: `npm run db:push` com o
   `DATABASE_URL` de produção no ambiente, ou configure isso como parte do
   build.

## Observações / limitações conhecidas

- **msedge-tts** depende de um serviço não-oficial da Microsoft; é gratuito
  mas pode ficar instável — se isso for um problema em produção, considere
  trocar `src/lib/tts.ts` por um provedor pago (Azure Speech, ElevenLabs
  etc.), mantendo a mesma assinatura `synthesizeSpeech(text, voice)`.
- **FFmpeg em serverless**: renderizar vídeo em uma function serverless da
  Vercel tem limite de tempo/memória. Para NRs muito longas (muitas cenas),
  pode ser necessário rodar o `render-and-upload-video` fora da Vercel (ex:
  um worker separado) ou aumentar o `maxDuration` da function.
- O roteiro gerado pelo Gemini deve ser revisado por um profissional de
  segurança do trabalho antes de ser usado como treinamento oficial — o
  modelo pode cometer erros de interpretação da norma.
