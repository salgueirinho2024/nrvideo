import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "@ffprobe-installer/ffprobe";
import path from "path";
import os from "os";
import { promises as fsp } from "fs";
import { nanoid } from "nanoid";
import { generateIntroSlide } from "./intro-slide";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

const RENDER_FPS = 30; // tem que bater com RENDER_FPS de render.ts (concat por -c copy exige fps igual)
const INTRO_DURATION_SECONDS = 3.2;
const WIDTH = 1920;
const HEIGHT = 1080;

export interface IntroClipInput {
  projectTitle: string;
  kicker?: string;
}

/**
 * Escreve um WAV silencioso (PCM 16-bit, estéreo, 44.1kHz) direto em disco,
 * sem depender do FFmpeg. Usado como trilha de áudio "vazia" do clipe de
 * abertura (o concat final exige que todo clipe tenha stream de áudio).
 *
 * NÃO usamos o filtro `anullsrc` (device virtual `-f lavfi`) porque a
 * versão do fluent-ffmpeg usada aqui faz um parse regex desatualizado da
 * saída de `ffmpeg -formats`: builds recentes do FFmpeg imprimem uma 3ª
 * coluna de flag pra formatos "device" (ex.: " D d lavfi ..."), e o regex
 * do fluent-ffmpeg (biblioteca sem manutenção ativa) só espera 2 colunas —
 * então ele conclui, errado, que "lavfi" não está disponível e lança
 * "Input format lavfi is not available" mesmo o FFmpeg suportando
 * perfeitamente. Escrever o WAV manualmente evita esse bug de vez.
 */
async function writeSilentWav(durationSeconds: number, outPath: string): Promise<void> {
  const sampleRate = 44100;
  const channels = 2;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const numSamples = Math.ceil(durationSeconds * sampleRate);
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  // resto já fica zerado (silêncio) por causa do Buffer.alloc

  await fsp.writeFile(outPath, buffer);
}

/**
 * Renderiza o clipe de abertura (introdução com a marca Previna-se) como
 * um mp4 com as MESMAS especificações técnicas dos clipes de cena
 * (renderSceneClip/renderSceneClipVideo em render.ts: 1920x1080, 30fps,
 * libx264, aac, yuv420p) — isso é obrigatório porque o `concatFinalVideo`
 * usa "-c copy" (concatenação sem re-encode); se algum clipe tiver
 * parâmetro diferente, a concatenação falha ou produz vídeo quebrado.
 *
 * Animação: fade-in do preto (0.5s) + leve zoom-in contínuo (zoompan, o
 * mesmo efeito Ken Burns usado nas cenas — dá sensação de "vídeo" mesmo
 * partindo de uma imagem estática) + fade-out pro próximo clipe (0.4s).
 * Áudio: trilha silenciosa (o concat exige que todo clipe tenha stream de
 * áudio, já que as cenas têm narração) — ver nota em generate-video.ts se
 * quiserem trocar por um efeito sonoro de abertura no futuro.
 */
export async function renderIntroClip(input: IntroClipInput): Promise<string> {
  const slidePath = await generateIntroSlide({
    projectTitle: input.projectTitle,
    kicker: input.kicker,
  });
  const outPath = path.join(os.tmpdir(), `intro-${nanoid(6)}.mp4`);

  const silentWavPath = path.join(os.tmpdir(), `intro-silence-${nanoid(6)}.wav`);
  await writeSilentWav(INTRO_DURATION_SECONDS + 0.5, silentWavPath);

  const totalFrames = Math.round(INTRO_DURATION_SECONDS * RENDER_FPS);
  const fadeOutStart = (INTRO_DURATION_SECONDS - 0.4).toFixed(2);

  // Zoom bem sutil (1.0 -> 1.06) ao longo dos 3.2s, igual em espírito ao
  // Ken Burns padrão das cenas (ver NORMAL_ZOOM_RATE em render.ts) — dá
  // movimento sem chamar atenção do texto/logo.
  const zoomExpr = `min(zoom+0.0018,1.06)`;

  const filters = [
    { filter: "scale", options: { w: WIDTH * 2, h: HEIGHT * 2 }, inputs: "0:v", outputs: "s0" },
    {
      filter: "zoompan",
      options: { z: zoomExpr, d: totalFrames, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)", s: `${WIDTH}x${HEIGHT}`, fps: RENDER_FPS },
      inputs: "s0",
      outputs: "zp",
    },
    {
      filter: "fade",
      options: { type: "in", start_time: 0, duration: 0.5, alpha: 0 },
      inputs: "zp",
      outputs: "f1",
    },
    {
      filter: "fade",
      options: { type: "out", start_time: fadeOutStart, duration: 0.4, alpha: 0 },
      inputs: "f1",
      outputs: "vout",
    },
  ];

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(slidePath)
      .inputOptions(["-loop 1"])
      // Trilha de áudio silenciosa (WAV gerado à parte, ver writeSilentWav)
      // com a mesma duração do clipe — mantém o stream de áudio consistente
      // com o resto do vídeo pro concat "-c copy" funcionar.
      .input(silentWavPath)
      .complexFilter(filters)
      .outputOptions([
        "-map [vout]",
        "-map 1:a",
        "-t",
        INTRO_DURATION_SECONDS.toFixed(2),
        "-r",
        String(RENDER_FPS),
        "-c:v libx264",
        "-preset veryfast",
        "-threads 2",
        "-c:a aac",
        "-b:a 192k",
        // Mesmo padrão fixo usado em renderSceneClip/renderSceneClipVideo —
        // todos os clipes precisam ter EXATAMENTE o mesmo sample
        // rate/canais de áudio pro concatFinalVideo ("-c copy") não gerar
        // um áudio final quebrado/mudo.
        "-ar 44100",
        "-ac 2",
        "-pix_fmt yuv420p",
        "-shortest",
      ])
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}
