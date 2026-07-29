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
  // true para as cenas mais importantes do roteiro (ver buildSystemPrompt).
  // Usada em render.ts para dar um Ken Burns mais dinâmico só nessas cenas.
  highlight: boolean;
  // true para até 3 cenas do roteiro inteiro (ver buildSystemPrompt) que
  // devem usar um clipe de vídeo real de banco de imagens em vez da
  // ilustração cartoon estática — ver src/lib/stock-video.ts. Escolhidas
  // pelo próprio Gemini como as cenas mais "mostráveis" em vídeo real (ex:
  // alguém de fato usando um EPI específico), não necessariamente as mesmas
  // marcadas como `highlight`.
  useStockVideo: boolean;
  // Palavras-chave EM INGLÊS (2 a 5 palavras) para buscar um vídeo de banco
  // que combine com a cena — só relevante quando useStockVideo = true.
  videoSearchQuery: string;
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

// Retry para erros transitórios do Gemini (503 "model overloaded"/UNAVAILABLE,
// 429 rate limit) — mesmo padrão de backoff exponencial com jitter usado em
// image-gen.ts. Sem isso, um único pico de indisponibilidade do Gemini
// derruba o step generate-script inteiro e só é reintentado pelo Inngest
// minutos depois (configurado via `retries` na function), então vale
// resolver aqui dentro primeiro, em segundos.
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 20000;
const RETRYABLE_STATUS = new Set([429, 503]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(attempt: number): number {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_RETRY_DELAY_MS;
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

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
- "imagePrompt": uma descrição visual, EM INGLÊS, do que a ilustração da cena deve mostrar — será usada por um gerador de imagens de IA. Descreva uma cena concreta e específica ao conteúdo daquela fala (pessoas, ações, ambiente, objetos/EPIs relevantes), não um resumo genérico. Sempre termine a descrição com o sufixo de estilo: "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image". Mantenha entre 1 e 3 frases. Preencha "imagePrompt" SEMPRE, mesmo em cenas com "useStockVideo": true (é o plano B caso não se ache um vídeo de banco adequado para a cena).
- "highlight": true ou false. Marque true em cerca de 1 a cada 3-4 cenas — as que representam o ponto mais importante ou de maior impacto do treinamento (ex: um risco grave, uma consequência de não usar o EPI, um procedimento crítico), não necessariamente a introdução ou o encerramento. Essas cenas recebem um efeito de câmera mais dinâmico no vídeo final. Nunca marque todas nem nenhuma cena como true.
- "useStockVideo": true ou false. Marque true em NO MÁXIMO 3 cenas de TODO o roteiro (nunca mais que 3, pode ser menos ou nenhuma se o tema não render bom vídeo real) — escolha as cenas mais concretas e "filmáveis" com pessoas/ações reais e genéricas o bastante para existir em um banco de vídeos de estoque (ex: "trabalhador colocando capacete", "pessoa calçando luvas de proteção", "operário usando protetor auricular numa fábrica"). Evite marcar cenas abstratas, jurídicas ou introdutórias/de encerramento — prefira cenas que mostrem literalmente uma ação ou um EPI em uso. As outras cenas ficam com "useStockVideo": false e usam a ilustração cartoon normal.
- "videoSearchQuery": só relevante quando "useStockVideo" é true (nas demais cenas, mande string vazia "") — 2 a 5 palavras-chave EM INGLÊS, genéricas e visuais, para buscar um vídeo real de banco de imagens que combine com a cena (ex: "worker wearing safety helmet", "hands putting on protective gloves", "factory worker safety glasses"). Não inclua nome de marca, texto ou termos jurídicos.
- Responda APENAS com um JSON válido, sem markdown, sem comentários, no formato exato:

{
  "title": "Título curto do treinamento",
  "scenes": [
    { "order": 1, "narrationText": "...", "screenText": "...", "imagePrompt": "A construction worker putting on a yellow safety helmet before entering a busy building site, flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image", "highlight": false, "useStockVideo": true, "videoSearchQuery": "worker wearing safety helmet construction" }
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

  const requestBody = JSON.stringify({
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
  });

  let response: Response | null = null;
  let lastErrText = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (response.ok) break;

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
      lastErrText = await response.text();
      break;
    }

    lastErrText = await response.text();
    console.error(
      `generateScript: tentativa ${attempt}/${MAX_ATTEMPTS} falhou (${response.status}): ${lastErrText}`
    );
    await sleep(computeRetryDelayMs(attempt));
  }

  if (!response || !response.ok) {
    throw new Error(`Gemini API falhou (${response?.status ?? "sem resposta"}): ${lastErrText}`);
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

  const normalizedScenes = parsed.scenes.map((s, i) => ({
    order: s.order ?? i + 1,
    narrationText: s.narrationText,
    screenText: s.screenText,
    imagePrompt:
      typeof s.imagePrompt === "string" && s.imagePrompt.trim().length > 0
        ? s.imagePrompt.trim()
        : `Illustration representing: ${s.screenText}. flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters in the image`,
    highlight: Boolean(s.highlight),
    useStockVideo: Boolean(s.useStockVideo),
    videoSearchQuery:
      typeof s.videoSearchQuery === "string" ? s.videoSearchQuery.trim() : "",
  }));

  // Rede de segurança: nunca confiar cegamente que o modelo respeitou o
  // "no máximo 3" do prompt. Se vier mais que isso, mantém só as 3
  // primeiras marcações e desliga o resto (essas cenas caem de volta pra
  // ilustração cartoon normal, que é sempre gerada de qualquer forma).
  const MAX_STOCK_VIDEO_SCENES = 3;
  let stockVideoCount = 0;
  for (const scene of normalizedScenes) {
    if (!scene.useStockVideo) continue;
    stockVideoCount++;
    if (stockVideoCount > MAX_STOCK_VIDEO_SCENES) {
      scene.useStockVideo = false;
    }
  }

  return {
    title: parsed.title || "Treinamento de Segurança do Trabalho",
    scenes: normalizedScenes,
    raw: data,
  };
}
