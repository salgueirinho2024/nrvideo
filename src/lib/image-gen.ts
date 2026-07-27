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

/**
 * Gera uma imagem PNG (cartoon) para uma cena com base num prompt visual,
 * salva em um arquivo temporário e retorna o caminho local.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

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
    throw new Error(`Gemini Image API falhou (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const parts: Array<{ inlineData?: { data?: string; mimeType?: string } }> =
    data?.candidates?.[0]?.content?.parts ?? [];

  const imagePart = parts.find((p) => p.inlineData?.data);
  const base64Data = imagePart?.inlineData?.data;

  if (!base64Data) {
    throw new Error(
      "Gemini não retornou uma imagem utilizável para a cena (verifique o prompt ou tente novamente)."
    );
  }

  const buffer = Buffer.from(base64Data, "base64");
  const outPath = path.join(os.tmpdir(), `scene-img-${nanoid(8)}.png`);
  await fs.writeFile(outPath, buffer);
  return outPath;
}
