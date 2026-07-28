// Gera a ilustração de cada cena via Pollinations.ai. Trocado do Hugging
// Face porque a conta usada neste projeto esgotou os créditos mensais
// gratuitos de Inference Providers, e do Gemini porque o modelo de imagem
// exige billing habilitado mesmo em uso baixo.
//
// ATENÇÃO (2026): o Pollinations migrou o endpoint de imagem do antigo
// `image.pollinations.ai/prompt/...` (sem chave, anônimo) para
// `gen.pollinations.ai/image/...`, com autenticação por API key (Bearer) e
// billing em "Pollen". Sem chave, a chamada ainda funciona no tier
// "anonymous", mas com fila de apenas 1 requisição simultânea por IP — é
// esse limite que gera o erro 429 "Queue full for IP" visto em produção,
// especialmente na Vercel, onde o IP de saída é compartilhado entre muitos
// projetos. Criar uma chave gratuita em https://enter.pollinations.ai
// (login via GitHub) já eleva bastante essa cota, sem precisar de cartão.
//
// Trade-off consciente: mesmo autenticado, o Pollinations não tem SLA de
// disponibilidade e moderação de conteúdo mais simples que provedores
// comerciais — mas resolve o bloqueio atual sem custo. Se no futuro for
// preciso mais confiabilidade, dá para trocar por um provedor pago sem
// mexer no resto do pipeline (a função generateSceneImage mantém a mesma
// assinatura).

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { detectImageFormat } from "./image-format";

const POLLINATIONS_ENDPOINT = "https://gen.pollinations.ai/image";
// Chave opcional — ver POLLINATIONS_API_KEY em .env.example. Sem ela, cai no
// tier "anonymous" (bem mais restrito, ver comentário acima).
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, square composition";

const MAX_ATTEMPTS = 4;
// Backoff usado quando o Pollinations NÃO manda um `Retry-After` (ex.:
// timeout de rede, 5xx sem esse header). Exponencial com jitter para evitar
// que várias cenas retentando ao mesmo tempo colidam de novo no mesmo
// segundo.
const BASE_RETRY_DELAY_MS = 4000;
// Teto de segurança para o valor de `Retry-After` — se o serviço mandar algo
// absurdamente alto, não vale a pena travar o pipeline esperando.
const MAX_RETRY_DELAY_MS = 30000;
// Tempo máximo de espera por tentativa: gerações de imagem no Pollinations
// podem demorar mais que uma chamada de API comum, especialmente em horários
// de pico.
const REQUEST_TIMEOUT_MS = 45000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcula quanto esperar antes da próxima tentativa. Prioriza o header
 * `Retry-After` da resposta (em segundos, ou uma data HTTP) quando presente
 * — é a orientação oficial do Pollinations para 429/503 — e só cai para o
 * backoff exponencial com jitter quando o header não vem.
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

/**
 * Faz UMA chamada de geração de imagem ao Pollinations. Lança erro com
 * mensagem específica e acionável em cada caso de falha conhecido, para que
 * o motivo real fique visível (no log e, a partir de generate-video.ts, no
 * banco/UI) em vez de a cena simplesmente sair sem ilustração. Quando a
 * falha é retentável, anexa `retryAfterMs` ao erro para o chamador decidir
 * quanto esperar.
 */
async function callPollinationsImageApi(prompt: string): Promise<Buffer> {
  const url =
    `${POLLINATIONS_ENDPOINT}/${encodeURIComponent(prompt)}` +
    `?width=1024&height=1024&model=flux&seed=${Math.floor(Math.random() * 1_000_000)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: POLLINATIONS_API_KEY
        ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` }
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      throw new Error(
        `Pollinations: tempo esgotado (${REQUEST_TIMEOUT_MS / 1000}s) esperando a imagem ser gerada.`
      );
    }
    throw new Error(`Pollinations: falha de rede ao chamar a API. Detalhe: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const retryAfterMs =
      response.status === 429 || response.status === 503
        ? computeRetryDelayMs(1, response.headers.get("retry-after"))
        : undefined;

    if (response.status === 429) {
      const hint = POLLINATIONS_API_KEY
        ? ""
        : " Sem POLLINATIONS_API_KEY configurada — rodando no tier anonymous, que só permite 1 requisição simultânea por IP. Crie uma chave gratuita em https://enter.pollinations.ai para elevar esse limite.";
      const err = new Error(
        `Pollinations: limite de uso momentâneo atingido (429).${hint} Detalhe: ${errText}`
      );
      (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      throw err;
    }
    const err = new Error(`Pollinations Image API falhou (${response.status}): ${errText}`);
    (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
    throw err;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Pollinations não retornou uma imagem utilizável (content-type inesperado: ${contentType}). Detalhe: ${text.slice(0, 300)}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error("Pollinations retornou uma imagem vazia para a cena.");
  }
  return Buffer.from(arrayBuffer);
}

/**
 * Gera uma imagem PNG/JPEG (cartoon) para uma cena com base num prompt
 * visual, salva em um arquivo temporário e retorna o caminho local.
 *
 * Faz até MAX_ATTEMPTS tentativas antes de desistir, pois falhas transitórias
 * (fila cheia no tier anonymous, timeout em horário de pico, 5xx momentâneo)
 * são comuns nesse serviço e não devem derrubar a ilustração da cena inteira
 * na primeira tentativa. O intervalo entre tentativas respeita o
 * `Retry-After` do Pollinations quando presente, com backoff exponencial e
 * jitter como fallback.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await callPollinationsImageApi(prompt);
      // O content-type do Pollinations nem sempre bate com os bytes reais
      // (ver src/lib/image-format.ts) — detecta pela assinatura binária para
      // que o arquivo salvo em disco já tenha a extensão certa.
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
