import type { Emotion } from "./types";

/** Palavras-gatilho específicas do domínio de NR (segurança do trabalho) —
 *  cenas de risco/acidente merecem uma emoção "alert", sem precisar de
 *  nenhuma chamada de API extra (roda em <1ms, é só regex). */
const KEYWORD_RULES: Array<{ pattern: RegExp; emotion: Emotion }> = [
  { pattern: /\b(risco|perigo|acidente|cuidado|atenção|fatal|morte|grave)\b/i, emotion: "alert" },
  { pattern: /\b(parabéns|ótimo|excelente|muito bem|sucesso)\b/i, emotion: "happy" },
  { pattern: /\b(obrigatório|proibido|nunca|jamais|deve|não pode|é vedado)\b/i, emotion: "serious" },
  { pattern: /\b(vamos|você consegue|dica|lembre-se|fique tranquilo)\b/i, emotion: "encouraging" },
];

export class EmotionDetector {
  /**
   * Heurística por palavra-chave — gratuita e determinística. Cobre a
   * maior parte dos casos porque roteiros de NR têm vocabulário previsível
   * (o próprio Gemini já escreve em tom didático/normativo).
   *
   * Evolução natural e de custo zero: pedir ao Gemini, na própria geração
   * do roteiro (src/lib/gemini.ts), para devolver um campo "emotion" por
   * cena no JSON — ele já faz uma chamada por vídeo, então não adiciona
   * nenhuma chamada de API nova. Esta função continua servindo de fallback
   * para quando esse campo vier vazio.
   */
  detectFromText(narrationText: string): Emotion {
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(narrationText)) return rule.emotion;
    }
    return "neutral";
  }
}
