import { spawn } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import type { VisemeTimeline, VisemeCue, VisemeShape } from "./types";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}

// Binário opcional do Rhubarb Lip Sync (ver README-LIPSYNC.md, seção 19,
// "próximos passos"). Se não existir no ambiente (ex.: ainda não foi
// baixado/commitado em scripts/rhubarb/rhubarb), o serviço cai
// automaticamente para o fallback heurístico abaixo — nunca quebra o
// pipeline por causa disso.
const RHUBARB_BIN = path.join(process.cwd(), "scripts", "rhubarb", "rhubarb");

interface RhubarbMouthCue {
  start: number;
  end: number;
  value: string; // A..X
}
interface RhubarbOutput {
  mouthCues: RhubarbMouthCue[];
}

const VALID_SHAPES: VisemeShape[] = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];

function normalizeShape(value: string): VisemeShape {
  return (VALID_SHAPES as string[]).includes(value) ? (value as VisemeShape) : "X";
}

// --- Fallback heurístico: vogal -> visema ---
// Sem um binário de análise fonética, não dá pra saber o fonema real a
// partir só do áudio em JS puro (é justamente o que o Rhubarb resolve). O
// fallback abaixo NÃO tenta analisar o áudio quadro a quadro — em vez
// disso, decompõe o TEXTO da narração em vogais (o que já captura a maior
// parte da abertura visual de boca de qualquer fala em português) e
// distribui essas "sílabas" proporcionalmente dentro dos trechos com voz
// real do áudio (detectados via `silencedetect` do FFmpeg, sem custo de
// API). É mais fiel que um ciclo artificial de 4 passos porque respeita o
// ritmo da frase (palavras longas recebem mais tempo/mais cues que
// palavras curtas) e ainda assim é 100% determinístico e gratuito.
const VOWEL_SHAPE: Record<string, VisemeShape> = {
  a: "D",
  á: "D",
  à: "D",
  â: "D",
  ã: "D",
  e: "E",
  é: "E",
  ê: "E",
  i: "B",
  í: "B",
  o: "G",
  ó: "G",
  ô: "G",
  õ: "G",
  u: "G",
  ú: "G",
};
// Consoantes bilabiais (lábios fechados) puxam o "chunk" pro visema A,
// mesmo quando a vogal seguinte pediria outro formato — é o traço mais
// visualmente marcante de uma consoante em português.
const BILABIAL = /[pbm]/i;

interface WordChunk {
  shape: VisemeShape;
  /** peso relativo dentro da palavra, usado só pra dividir a duração da
   *  palavra entre os chunks (não precisa ser preciso). */
  weight: number;
}

function splitWordIntoChunks(word: string): WordChunk[] {
  const lower = word.toLowerCase();
  const chunks: WordChunk[] = [];
  let pendingConsonants = "";

  for (const ch of lower) {
    if (ch in VOWEL_SHAPE) {
      const shape = BILABIAL.test(pendingConsonants) ? "A" : VOWEL_SHAPE[ch];
      chunks.push({ shape, weight: 1 });
      pendingConsonants = "";
    } else if (/[a-zçñ]/i.test(ch)) {
      pendingConsonants += ch;
    }
  }
  // Palavra sem vogal reconhecida (raro) — um único chunk fechado/neutro.
  if (chunks.length === 0) {
    chunks.push({ shape: BILABIAL.test(lower) ? "A" : "B", weight: 1 });
  }
  return chunks;
}

interface SpeakingSegment {
  start: number;
  end: number;
}

/**
 * Roda `silencedetect` sobre o áudio (sem gerar arquivo de saída) e retorna
 * os trechos SEM silêncio (onde a boca deve de fato se mexer). Se a
 * análise falhar por qualquer motivo, assume o áudio inteiro como "falando"
 * — mais seguro do que travar o pipeline.
 */
function detectSpeakingSegments(
  audioPath: string,
  durationSeconds: number
): Promise<SpeakingSegment[]> {
  const NOISE_THRESHOLD_DB = -30;
  const MIN_SILENCE_DURATION = 0.15;

  return new Promise((resolve) => {
    let log = "";
    ffmpeg(audioPath)
      .audioFilters(`silencedetect=noise=${NOISE_THRESHOLD_DB}dB:d=${MIN_SILENCE_DURATION}`)
      .outputOptions(["-f null"])
      .output(process.platform === "win32" ? "NUL" : "/dev/null")
      .on("stderr", (line: string) => {
        log += line + "\n";
      })
      .on("end", () => {
        const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) =>
          parseFloat(m[1])
        );
        const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) =>
          parseFloat(m[1])
        );
        const silences: SpeakingSegment[] = starts.map((start, i) => ({
          start,
          end: ends[i] !== undefined ? ends[i] : durationSeconds,
        }));

        if (silences.length === 0) {
          resolve([{ start: 0, end: durationSeconds }]);
          return;
        }

        const speaking: SpeakingSegment[] = [];
        let cursor = 0;
        for (const s of silences) {
          if (s.start > cursor) speaking.push({ start: cursor, end: s.start });
          cursor = Math.max(cursor, s.end);
        }
        if (cursor < durationSeconds) speaking.push({ start: cursor, end: durationSeconds });
        resolve(speaking.length > 0 ? speaking : [{ start: 0, end: durationSeconds }]);
      })
      .on("error", () => resolve([{ start: 0, end: durationSeconds }]))
      .run();
  });
}

/**
 * Extrai fonemas/visemas de um áudio. Tenta o Rhubarb Lip Sync primeiro
 * (fonemas reais, alta precisão); se o binário não estiver disponível no
 * ambiente ou a execução falhar, cai para o fallback heurístico baseado em
 * vogais do texto + trechos de fala reais do áudio.
 */
export class PhonemeService {
  async extractVisemes(
    audioFilePath: string,
    sceneId: string,
    durationSeconds: number,
    dialogText?: string
  ): Promise<VisemeTimeline> {
    try {
      await fs.access(RHUBARB_BIN);
      return await this.extractWithRhubarb(audioFilePath, sceneId, durationSeconds, dialogText);
    } catch (err) {
      console.warn(
        `[lipsync] Rhubarb indisponível ou falhou na cena ${sceneId}, usando fallback heurístico: ` +
          (err instanceof Error ? err.message : String(err))
      );
      return this.extractWithHeuristic(
        audioFilePath,
        sceneId,
        durationSeconds,
        dialogText ?? ""
      );
    }
  }

  private async extractWithRhubarb(
    audioFilePath: string,
    sceneId: string,
    durationSeconds: number,
    dialogText?: string
  ): Promise<VisemeTimeline> {
    const outputJsonPath = audioFilePath.replace(/\.(mp3|wav)$/i, ".rhubarb.json");
    // Recognizer "phonetic" (em vez do padrão "pocketSphinx", que só
    // reconhece inglês) — necessário porque a narração é em português.
    const args = ["-o", outputJsonPath, "--exportFormat", "json", "-r", "phonetic"];

    let dialogPath: string | null = null;
    if (dialogText) {
      // Passar o texto da narração melhora muito a precisão do
      // alinhamento (forced alignment), especialmente em termos técnicos
      // de NR que um dicionário fonético genérico não reconheceria bem.
      dialogPath = audioFilePath.replace(/\.(mp3|wav)$/i, ".txt");
      await fs.writeFile(dialogPath, dialogText, "utf-8");
      args.push("-d", dialogPath);
    }
    args.push(audioFilePath);

    await this.runBinary(args);

    const raw = await fs.readFile(outputJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as RhubarbOutput;
    const cues: VisemeCue[] = parsed.mouthCues.map((c) => ({
      start: c.start,
      end: c.end,
      shape: normalizeShape(c.value),
    }));

    await fs.unlink(outputJsonPath).catch(() => undefined);
    if (dialogPath) await fs.unlink(dialogPath).catch(() => undefined);

    return { sceneId, durationSeconds, cues, source: "rhubarb" };
  }

  private runBinary(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(RHUBARB_BIN, args);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Rhubarb saiu com código ${code}: ${stderr}`));
      });
      proc.on("error", reject);
    });
  }

  private async extractWithHeuristic(
    audioFilePath: string,
    sceneId: string,
    durationSeconds: number,
    text: string
  ): Promise<VisemeTimeline> {
    const speakingSegments = await detectSpeakingSegments(audioFilePath, durationSeconds);
    const words = text.trim().split(/\s+/).filter(Boolean);

    if (words.length === 0 || speakingSegments.length === 0) {
      return {
        sceneId,
        durationSeconds,
        cues: [{ start: 0, end: durationSeconds, shape: "X" }],
        source: "heuristic",
      };
    }

    // Cada palavra vira uma lista de "chunks" (aprox. sílabas, por vogal).
    // O peso de cada palavra (pra dividir o tempo total de fala) é a soma
    // dos pesos dos seus chunks — palavras mais longas ganham mais tempo.
    const wordChunks = words.map(splitWordIntoChunks);
    const totalWeight = wordChunks.reduce(
      (sum, chunks) => sum + chunks.reduce((s, c) => s + c.weight, 0),
      0
    );
    const totalSpeakingDuration = speakingSegments.reduce(
      (sum, seg) => sum + (seg.end - seg.start),
      0
    );

    // Percorre os trechos de fala como uma única "fita" contínua (soma das
    // durações), convertendo cada posição virtual de volta pro tempo real
    // do segmento correspondente — assim os cues nunca caem dentro de uma
    // pausa detectada.
    const cues: VisemeCue[] = [];
    let segIdx = 0;
    let segElapsed = 0; // tempo já consumido dentro do segmento atual

    const advance = (deltaSeconds: number): { start: number; end: number } => {
      const start = speakingSegments[segIdx].start + segElapsed;
      let remaining = deltaSeconds;
      let end = start;
      while (remaining > 0 && segIdx < speakingSegments.length) {
        const segLength = speakingSegments[segIdx].end - speakingSegments[segIdx].start;
        const available = segLength - segElapsed;
        if (remaining <= available) {
          segElapsed += remaining;
          end = speakingSegments[segIdx].start + segElapsed;
          remaining = 0;
        } else {
          remaining -= available;
          segIdx += 1;
          segElapsed = 0;
          end = segIdx < speakingSegments.length ? speakingSegments[segIdx].start : end;
        }
      }
      return { start, end: Math.max(end, start) };
    };

    for (const chunks of wordChunks) {
      const wordWeight = chunks.reduce((s, c) => s + c.weight, 0);
      const wordDuration = totalWeight > 0 ? (wordWeight / totalWeight) * totalSpeakingDuration : 0;
      if (wordDuration <= 0 || segIdx >= speakingSegments.length) continue;

      for (const chunk of chunks) {
        const chunkDuration = (chunk.weight / wordWeight) * wordDuration;
        if (chunkDuration <= 0 || segIdx >= speakingSegments.length) continue;
        const { start, end } = advance(chunkDuration);
        if (end > start) {
          cues.push({ start, end, shape: chunk.shape });
        }
      }
    }

    if (cues.length === 0) {
      cues.push({ start: 0, end: durationSeconds, shape: "X" });
    }

    return { sceneId, durationSeconds, cues, source: "heuristic" };
  }
}
