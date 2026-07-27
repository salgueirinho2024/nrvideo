// Gera a ilustração de cada cena chamando o modelo de geração de imagens do
// Gemini (via REST, mesmo padrão usado em src/lib/gemini.ts). Substitui o
// antigo "boneco" desenhado em SVG/satori: agora cada cena ganha uma imagem
// única, criada pela IA a partir do imagePrompt daquela cena — funciona para
// qualquer assunto, não só para o vocabulário fixo de EPIs.

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

const IMAGE_MODEL = "gemini-2.5-flash-image";

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, square composition";

const MAX_ATTEMPTS = 3;
// Backoff simples entre tentativas (ms). Cobre principalmente erros
// transitórios (429/5xx) e respostas sem imagem por instabilidade do modelo.
const RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz UMA chamada à API de geração de imagem do Gemini. Lança erro com
 * mensagem específica e acionável em cada caso de falha conhecido, para que
 * o motivo real fique visível (no log e, a partir de generate-video.ts, no
 * banco/UI) em vez de a cena simplesmente sair sem ilustração.
 */
async function callGeminiImageApi(prompt: string, apiKey: string): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        // Importante: o modelo NÃO aceita gerar só imagem — a resposta
        // precisa incluir TEXT junto com IMAGE, senão a API retorna erro
        // (o que antes fazia a geração de imagem falhar silenciosamente
        // em toda cena, e o slide saía sem ilustração nenhuma).
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    // 401/403 quase sempre é chave inválida/sem permissão; 429 é quota.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Gemini Image API recusou a chave (${response.status}). Verifique se GEMINI_API_KEY é válida e tem acesso ao modelo ${IMAGE_MODEL}. Detalhe: ${errText}`
      );
    }
    if (response.status === 429) {
      throw new Error(
        `Gemini Image API: limite de quota/rate atingido (429). Detalhe: ${errText}`
      );
    }
    throw new Error(`Gemini Image API falhou (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];

  // Bloqueio de segurança: a API responde 200 OK mas sem imagem, indicando
  // o motivo em finishReason (ex: "SAFETY", "PROHIBITED_CONTENT").
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(
      `Gemini Image API não gerou imagem (finishReason: ${finishReason}). O prompt da cena provavelmente foi bloqueado por segurança/conteúdo.`
    );
  }

  const parts: Array<{ inlineData?: { data?: string; mimeType?: string } }> =
    candidate?.content?.parts ?? [];

  const imagePart = parts.find((p) => p.inlineData?.data);
  const base64Data = imagePart?.inlineData?.data;

  if (!base64Data) {
    throw new Error(
      "Gemini não retornou uma imagem utilizável para a cena (resposta sem inlineData)."
    );
  }

  return Buffer.from(base64Data, "base64");
}

/**
 * Gera uma imagem PNG (cartoon) para uma cena com base num prompt visual,
 * salva em um arquivo temporário e retorna o caminho local.
 *
 * Faz até MAX_ATTEMPTS tentativas antes de desistir, pois falhas transitórias
 * (quota momentânea, resposta sem imagem) são comuns nesse modelo e não devem
 * derrubar a ilustração da cena inteira na primeira tentativa.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY não configurada no ambiente onde o worker roda (verifique as env vars do projeto/Inngest)."
    );
  }

  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await callGeminiImageApi(prompt, apiKey);
      const outPath = path.join(os.tmpdir(), `scene-img-${nanoid(8)}.png`);
      await fs.writeFile(outPath, buffer);
      return outPath;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `generateSceneImage: tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${message}`
      );
      // Chave ausente/inválida não se resolve tentando de novo.
      if (message.includes("GEMINI_API_KEY") || message.includes("recusou a chave")) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Falha desconhecida ao gerar imagem da cena.");
}
