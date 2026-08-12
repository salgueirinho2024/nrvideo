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
- **Cloudflare R2** — armazena áudios, slides e o vídeo final

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
    storage.ts       # Upload para o Cloudflare R2
    download.ts      # Baixa asset remoto para /tmp (necessário entre steps do Inngest)
  db/
    schema.ts         # projects, scenes, scriptLogs
    index.ts           # Cliente Drizzle (Neon HTTP)
public/fonts/Inter-Bold.woff   # Fonte usada nos slides
```

## Como funciona o pipeline (Inngest)

1. **generate-script**: chama o Gemini com o texto da NR, recebe um roteiro
   em JSON (título + cenas), grava as cenas no banco. O próprio Gemini
   escolhe até **3 cenas** que se beneficiam de um vídeo real (ex: alguém
   usando um EPI específico) e gera para elas uma `videoSearchQuery` em
   inglês (o banco de vídeos é em inglês); as demais cenas continuam usando
   imagem estática.
2. **generate-assets-scene-N** (uma etapa por cena): gera o áudio (TTS)
   sempre. Para o slide/imagem, verifica `useStockVideo`:
   - se `true` e `PEXELS_API_KEY` estiver configurada, busca e baixa um
     clipe do Pexels que combine com `videoSearchQuery`;
   - se a busca falhar (sem resultado, sem chave, erro de rede), cai de
     volta automaticamente para o fluxo normal de imagem estática — a cena
     nunca fica sem mídia por causa disso.
3. **render-and-upload-video**: baixa os assets de todas as cenas para
   `/tmp`. Cenas com vídeo real usam `renderSceneClipVideo` (o vídeo de
   fundo entra em loop/crop para preencher o quadro, com o texto/legenda e
   o mascote sobrepostos em modo transparente); as demais continuam usando
   `renderSceneClip` (imagem + Ken Burns), com a mesma animação de boca do
   mascote nos dois casos. No fim concatena tudo e envia o vídeo final para
   o R2.
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
- `POLLINATIONS_API_KEY` (opcional, mas recomendado): crie uma chave grátis
  (tipo "secret") em [enter.pollinations.ai](https://enter.pollinations.ai)
  via login com GitHub. Sem ela, a geração de ilustração das cenas roda no
  tier anônimo do Pollinations, que só permite 1 requisição simultânea por
  IP e costuma dar 429 "Queue full for IP" em produção
- `R2_BUCKET_NAME` / `R2_PUBLIC_URL` / `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY`: crie um bucket R2 grátis (10GB, sem cartão) em
  Cloudflare → R2 Object Storage, ative o acesso público e gere um API
  Token específico do bucket — ver `.env.example` para o passo a passo
- `PEXELS_API_KEY` (opcional, mas necessário para vídeos temáticos): chave
  gratuita em [pexels.com/api](https://www.pexels.com/api/) usada para
  buscar clipes reais de banco de vídeo para até 3 cenas do roteiro (ex: um
  trabalhador colocando EPI). Sem essa chave, o pipeline simplesmente não
  tenta usar vídeo de banco e volta a gerar todas as cenas como imagem
  estática (Ken Burns), sem quebrar nada.

### 3. Criar as tabelas no banco

```bash
npm run db:push
```

> Se você já tinha o banco criado de uma versão anterior, rode `npm run
> db:push` de novo depois de atualizar — a tabela `scenes` ganhou colunas
> novas (`mediaType`, `videoSearchQuery`, `sceneVideoUrl`) usadas pelos
> vídeos temáticos.

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
2. Conecte um **Neon Postgres** ao projeto (Storage tab) — isso preenche
   `DATABASE_URL` automaticamente. Crie o bucket **Cloudflare R2** à parte
   (ver `.env.example`) e cole as variáveis `R2_*` manualmente.
3. Adicione `GEMINI_API_KEY` nas variáveis de ambiente do projeto.
4. Instale a [integração do Inngest](https://vercel.com/integrations/inngest)
   (preenche `INNGEST_EVENT_KEY` e `INNGEST_SIGNING_KEY` e registra
   `/api/inngest` automaticamente).
5. Rode as migrations contra o banco de produção: `npm run db:push` com o
   `DATABASE_URL` de produção no ambiente, ou configure isso como parte do
   build.

## Observações / limitações conhecidas

- **Pollinations (ilustração das cenas)**: o serviço migrou o endpoint de
  imagem para `gen.pollinations.ai` com autenticação por API key. Sem
  `POLLINATIONS_API_KEY` configurada, as chamadas rodam no tier "anonymous",
  limitado a 1 requisição simultânea por IP — na Vercel, onde o IP de saída
  é compartilhado entre muitos projetos, isso aparece como 429 "Queue full
  for IP" mesmo com pouco tráfego próprio. `src/lib/image-gen.ts` já retenta
  respeitando o `Retry-After` da resposta, mas o jeito mais confiável de
  evitar o erro é configurar a chave gratuita (ver seção de variáveis de
  ambiente acima).
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
- **Sincronização labial do mascote**: a boca "de bico" era causada pela
  foto de boca aberta usada (`mouth-open-1.png`, a única alinhada certinho
  com o enquadramento da boca fechada, mas com formato de "O"). Isso foi
  corrigido realinhando uma foto de boca aberta mais natural (com os dentes
  aparecendo) via detecção de características (ORB + RANSAC) para bater
  exatamente no enquadramento de `mouth-closed.png`, e trocando o corte seco
  fechada↔aberta por um ciclo de 4 passos com frame intermediário
  (fechada → meio-aberta → aberta → meio-aberta) em `render.ts`. Se algum
  dia quiser trocar a foto-base de novo, use `mouth-open-2.png` ou
  `mouth-open-3.png` como fonte e repita o realinhamento — usar qualquer uma
  das fotos de boca aberta sem realinhar volta a causar o "pulo".
- **Vídeos temáticos (Pexels)**: a variedade depende do que existe no banco
  gratuito do Pexels para a busca em inglês gerada pelo Gemini; termos muito
  específicos de norma brasileira podem não ter resultado, caso em que a
  cena cai automaticamente para imagem estática. Para clipes 100% sob
  medida (e não apenas os melhores disponíveis no banco), a alternativa
  seria geração de vídeo por IA (ex: Replicate/fal.ai), que tem custo por
  vídeo gerado — não implementada por enquanto.
