// Gera a ilustração de cada cena via Cloudflare Workers AI (modelo
// @cf/black-forest-labs/flux-1-schnell).
//
// HISTÓRICO: antes usava Hugging Face (esgotou os créditos gratuitos de
// Inference Providers), depois o Gemini (modelo de imagem exige billing
// habilitado mesmo em uso baixo), depois o Pollinations.ai (gen.pollinations.ai)
// — que documentava o modelo flux como "gratuito e ilimitado, sempre", mas na
// prática passou a cobrar Pollen por imagem mesmo pra esse modelo, e contas
// novas/anônimas ficam com saldo 0, gerando erro 402 "Insufficient balance"
// (ver https://github.com/pollinations/pollinations/issues/8417, onde a
// própria comunidade pede pra reduzir esse custo do flux).
//
// Trocado para Cloudflare Workers AI porque o tier free de lá é genuinamente
// gratuito e sem cartão: 10.000 "neurons" por dia, resetando à meia-noite UTC,
// suficiente pra várias centenas de imagens/dia nesse caso de uso (ver
// https://developers.cloudflare.com/workers-ai/platform/pricing/). O modelo
// flux-1-schnell é uma versão rápida/destilada do mesmo Flux usado antes.
//
// Trade-off consciente: o tier free da Cloudflare também não tem SLA de
// disponibilidade, e o limite diário é compartilhado entre TODOS os modelos
// de IA usados na mesma conta Cloudflare (não só imagem) — se o projeto
// crescer muito ou a conta for usada pra outras coisas, pode esbarrar no teto
// diário. Se no futuro for preciso mais confiabilidade/volume, dá pra trocar
// de provedor sem mexer no resto do pipeline (a função generateSceneImage
// mantém a mesma assinatura).

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { detectImageFormat } from "./image-format";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, wide 16:9 cinematic composition, subject centered with room around it for text overlay";

const MAX_ATTEMPTS = 4;
// Backoff usado quando a Cloudflare NÃO manda um `Retry-After` (ex.: timeout
// de rede, 5xx sem esse header). Exponencial com jitter para evitar que
// várias cenas retentando ao mesmo tempo colidam de novo no mesmo segundo.
const BASE_RETRY_DELAY_MS = 4000;
// Teto de segurança para o valor de `Retry-After` — se o serviço mandar algo
// absurdamente alto, não vale a pena travar o pipeline esperando.
const MAX_RETRY_DELAY_MS = 30000;
// Tempo máximo de espera por tentativa.
const REQUEST_TIMEOUT_MS = 45000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcula quanto esperar antes da próxima tentativa. Prioriza o header
 * `Retry-After` da resposta quando presente, e só cai para o backoff
 * exponencial com jitter quando o header não vem.
 */
function computeRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (Number.isFinite(asSeconds)) {
      return Math.min(Math.max(asSeconds, 0) * 1000, MAX_RETRY_DELAY_MS);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_RETRY_DELAY_MS;
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

type CloudflareAiResponse = {
  success: boolean;
  result?: { image?: string } | null;
  errors?: Array<{ code?: number; message?: string }>;
};

/**
 * Faz UMA chamada de geração de imagem à Cloudflare Workers AI. Lança erro
 * com mensagem específica e acionável em cada caso de falha conhecido, para
 * que o motivo real fique visível (no log e, a partir de generate-video.ts,
 * no banco/UI) em vez de a cena simplesmente sair sem ilustração. Quando a
 * falha é retentável, anexa `retryAfterMs` ao erro para o chamador decidir
 * quanto esperar.
 */
async function callCloudflareImageApi(prompt: string): Promise<Buffer> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error(
      "Cloudflare: CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_API_TOKEN não configurados. " +
        "Crie uma conta grátis em https://dash.cloudflare.com (sem cartão), pegue o " +
        "Account ID e gere um API Token com permissão de Workers AI, e configure " +
        "essas duas variáveis de ambiente."
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_MODEL}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        seed: Math.floor(Math.random() * 1_000_000),
        // steps: o flux-1-schnell é otimizado justamente para poucos steps
        // (é a versão "destilada" do Flux, feita pra convergir rápido).
        // 4 steps já dá resultado visualmente equivalente a 8 pra ilustração
        // cartoon simples, e cada step custa 9.60 neurons — reduzir pela
        // metade quase dobra quantas imagens cabem na cota diária gratuita
        // de 10.000 neurons (ver https://developers.cloudflare.com/workers-ai/platform/pricing/).
        steps: 4,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      throw new Error(
        `Cloudflare: tempo esgotado (${REQUEST_TIMEOUT_MS / 1000}s) esperando a imagem ser gerada.`
      );
    }
    throw new Error(`Cloudflare: falha de rede ao chamar a API. Detalhe: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  const retryAfterMs =
    response.status === 429 || response.status === 503
      ? computeRetryDelayMs(1, response.headers.get("retry-after"))
      : undefined;

  if (response.status === 401 || response.status === 403) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Cloudflare: autenticação falhou (${response.status}). Confira se ` +
        `CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN estão corretos e se o token ` +
        `tem permissão "Workers AI - Read". Detalhe: ${errText}`
    );
  }

  if (response.status === 429) {
    // Nem todo 429 da Cloudflare é cota diária esgotada — a maioria é rate
    // limit de curto prazo (requisições rápidas demais em sequência), que
    // se resolve sozinho com espera curta e DEVE ser retentado. A cota
    // diária de verdade vem com o código de erro específico 4006 no corpo
    // da resposta (mensagem "you have used up your daily free allocation
    // of 10,000 neurons..."). Só nesse caso não vale a pena retentar.
    const errBody = await response.json().catch(() => null) as CloudflareAiResponse | null;
    const isDailyQuotaCode = errBody?.errors?.some((e) => e.code === 4006) ?? false;

    if (isDailyQuotaCode) {
      const err = new Error(
        "Cloudflare: limite diário de neurons (cota gratuita) atingido por hoje. " +
          "O limite reseta à meia-noite UTC. Confira o uso em " +
          "https://dash.cloudflare.com > Workers AI > Usage."
      );
      (err as Error & { dailyQuotaExceeded?: boolean }).dailyQuotaExceeded = true;
      throw err;
    }

    const errDetail =
      errBody?.errors?.map((e) => `${e.code ?? "?"}: ${e.message ?? "erro desconhecido"}`).join("; ") ??
      "sem detalhe no corpo da resposta";
    const err = new Error(
      `Cloudflare: rate limit de curto prazo (429, não é cota diária). Detalhe: ${errDetail}`
    );
    (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
    throw err;
  }

  let json: CloudflareAiResponse | null = null;
  try {
    json = (await response.json()) as CloudflareAiResponse;
  } catch {
    json = null;
  }

  if (!response.ok || !json?.success || !json.result?.image) {
    const errDetail =
      json?.errors?.map((e) => `${e.code ?? "?"}: ${e.message ?? "erro desconhecido"}`).join("; ") ??
      `HTTP ${response.status}`;
    const err = new Error(`Cloudflare Workers AI falhou ao gerar a imagem da cena. Detalhe: ${errDetail}`);
    (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
    throw err;
  }

  const buffer = Buffer.from(json.result.image, "base64");
  if (buffer.length === 0) {
    throw new Error("Cloudflare retornou uma imagem vazia para a cena.");
  }
  return buffer;
}

/**
 * Gera uma imagem PNG/JPEG (cartoon) para uma cena com base num prompt
 * visual, salva em um arquivo temporário e retorna o caminho local.
 *
 * Faz até MAX_ATTEMPTS tentativas antes de desistir, pois falhas transitórias
 * (timeout em horário de pico, 5xx momentâneo) são comuns e não devem
 * derrubar a ilustração da cena inteira na primeira tentativa. O intervalo
 * entre tentativas respeita o `Retry-After` quando presente, com backoff
 * exponencial e jitter como fallback.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await callCloudflareImageApi(prompt);
      // A Cloudflare retorna JPEG pra esse modelo, mas detecta pela
      // assinatura binária (em vez de assumir) pra manter o arquivo salvo em
      // disco com a extensão certa mesmo se isso mudar no futuro.
      const { ext } = detectImageFormat(buffer);
      const outPath = path.join(os.tmpdir(), `scene-img-${nanoid(8)}.${ext}`);
      await fs.writeFile(outPath, buffer);
      return outPath;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `generateSceneImage: tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${message}`
      );
      const dailyQuotaExceeded = (err as Error & { dailyQuotaExceeded?: boolean })?.dailyQuotaExceeded;
      if (dailyQuotaExceeded) {
        // Sem sentido retentar: a cota só volta à meia-noite UTC. Desiste
        // na hora pra essa cena (fica sem ilustração, conforme tratado em
        // generate-video.ts) em vez de gastar minutos em retries inúteis.
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        const retryAfterMs = (err as Error & { retryAfterMs?: number })?.retryAfterMs;
        const delay = retryAfterMs ?? computeRetryDelayMs(attempt, null);
        await sleep(delay);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Falha desconhecida ao gerar imagem da cena.");
}
