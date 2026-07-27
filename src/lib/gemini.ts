// Chama a API do Gemini diretamente via REST (evita depender de uma versão
// específica do SDK oficial, que muda com frequência).

export interface GeneratedScene {
  order: number;
  narrationText: string;
  screenText: string;
}

export interface GeneratedScript {
  title: string;
  scenes: GeneratedScene[];
  raw: unknown;
}

const GEMINI_MODEL = "gemini-flash-latest";

const SYSTEM_PROMPT = `Você é um roteirista especialista em treinamentos de segurança do trabalho (Normas Regulamentadoras - NRs) no Brasil.

Você receberá o texto de uma NR (ou parte dela) e deve transformá-lo em um roteiro de vídeo de treinamento, dividido em cenas curtas.

Regras:
- Cada cena deve ter no máximo 2-3 frases narradas (para caber em ~15-25 segundos de áudio).
- Use linguagem clara, direta e didática, como se estivesse explicando para um trabalhador que vai assistir ao vídeo, não para um jurista.
- "screenText" é um texto curto (título ou 1 frase) que aparece escrito na tela durante a cena — deve resumir a ideia central da cena, não repetir a narração palavra por palavra.
- Gere entre 6 e 14 cenas, cobrindo: introdução ao tema, os pontos principais da norma, riscos envolvidos, medidas de prevenção/EPIs quando aplicável, e uma cena de encerramento/reforço.
- Responda APENAS com um JSON válido, sem markdown, sem comentários, no formato exato:

{
  "title": "Título curto do treinamento",
  "scenes": [
    { "order": 1, "narrationText": "...", "screenText": "..." }
  ]
}`;

export async function generateScript(sourceText: string): Promise<GeneratedScript> {
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
              text: `${SYSTEM_PROMPT}\n\n--- TEXTO DA NR ---\n${sourceText}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.6,
        responseMimeType: "application/json",
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
    })),
    raw: data,
  };
}
