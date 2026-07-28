// Chama a API do Gemini diretamente via REST (evita depender de uma versão
// específica do SDK oficial, que muda com frequência).

export interface GeneratedScene {
  order: number;
  narrationText: string;
  screenText: string;
  // Descrição visual livre (em inglês, para melhor resultado no modelo de
  // imagem) do que a ilustração da cena deve mostrar. Gerada pelo próprio
  // Gemini a partir do conteúdo da cena — não depende de um vocabulário fixo,
  // então funciona para qualquer assunto/tema, não só EPIs específicos.
  imagePrompt: string;
}

export interface GeneratedScript {
  title: string;
  scenes: GeneratedScene[];
  raw: unknown;
}

const GEMINI_MODEL = "gemini-flash-latest";

// Duração média assumida por cena (narração + slide), em segundos. Usada só
// para estimar quantas cenas pedir ao Gemini a partir da duração alvo.
const AVG_SCENE_SECONDS = 20;
const MIN_SCENES = 6;
const MAX_SCENES = 70; // teto de segurança (custo de API, tempo de render em serverless)
export const MIN_TARGET_MINUTES = 1;
export const MAX_TARGET_MINUTES = 15;

function buildSystemPrompt(targetMinutes: number): string {
  const clampedMinutes = Math.min(
    MAX_TARGET_MINUTES,
    Math.max(MIN_TARGET_MINUTES, targetMinutes)
  );
  const estimatedScenes = Math.min(
    MAX_SCENES,
    Math.max(MIN_SCENES, Math.round((clampedMinutes * 60) / AVG_SCENE_SECONDS))
  );

  return `Você é um roteirista especialista em treinamentos de segurança do trabalho (Normas Regulamentadoras - NRs) no Brasil.

Você receberá o texto de uma NR (ou parte dela) e deve transformá-lo em um roteiro de vídeo de treinamento, dividido em cenas curtas.

Regras:
- Cada cena deve ter no máximo 2-3 frases narradas (para caber em ~15-25 segundos de áudio).
- Use linguagem clara, direta e didática, como se estivesse explicando para um trabalhador que vai assistir ao vídeo, não para um jurista.
- "screenText" é um texto curto (título ou 1 frase) que aparece escrito na tela durante a cena — deve resumir a ideia central da cena, não repetir a narração palavra por palavra.
- A duração alvo do vídeo final é de aproximadamente ${clampedMinutes} minuto(s). Como cada cena dura ~15-25s de áudio, isso equivale a cerca de ${estimatedScenes} cenas — gere um número de cenas próximo desse alvo (nunca menos que ${MIN_SCENES}, nunca mais que ${MAX_SCENES}). Para vídeos mais longos, aprofunde: divida os pontos principais da norma em mais cenas, com exemplos e situações práticas, além de cobrir introdução ao tema, riscos envolvidos, medidas de prevenção/EPIs quando aplicável, e uma cena de encerramento/reforço.
- "imagePrompt": uma descrição visual, EM INGLÊS, do que a ilustração da cena deve mostrar — será usada por um gerador de imagens de IA. Descreva uma cena concreta e específica ao conteúdo daquela fala (pessoas, ações, ambiente, objetos/EPIs relevantes), não um resumo genérico. Sempre termine a descrição com o sufixo de estilo: "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image". Mantenha entre 1 e 3 frases.
- Responda APENAS com um JSON válido, sem markdown, sem comentários, no formato exato:

{
  "title": "Título curto do treinamento",
  "scenes": [
    { "order": 1, "narrationText": "...", "screenText": "...", "imagePrompt": "A construction worker putting on a yellow safety helmet before entering a busy building site, flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image" }
  ]
}`;
}

export async function generateScript(
  sourceText: string,
  targetMinutes: number = 5
): Promise<GeneratedScript> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${buildSystemPrompt(targetMinutes)}\n\n--- TEXTO DA NR ---\n${sourceText}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.6,
        responseMimeType: "application/json",
        // Roteiros longos (~15 min / ~45-70 cenas) geram um JSON bem maior;
        // o default do modelo pode truncar a resposta e quebrar o JSON.
        maxOutputTokens: 32768,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API falhou (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textOutput: string | undefined =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textOutput) {
    throw new Error("Gemini não retornou conteúdo utilizável.");
  }

  let parsed: { title?: string; scenes?: GeneratedScene[] };
  try {
    parsed = JSON.parse(textOutput);
  } catch {
    throw new Error("Não foi possível interpretar o JSON retornado pelo Gemini.");
  }

  if (!parsed.scenes || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("O roteiro gerado não contém cenas válidas.");
  }

  return {
    title: parsed.title || "Treinamento de Segurança do Trabalho",
    scenes: parsed.scenes.map((s, i) => ({
      order: s.order ?? i + 1,
      narrationText: s.narrationText,
      screenText: s.screenText,
      imagePrompt:
        typeof s.imagePrompt === "string" && s.imagePrompt.trim().length > 0
          ? s.imagePrompt.trim()
          : `Illustration representing: ${s.screenText}. flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image`,
    })),
    raw: data,
  };
}
