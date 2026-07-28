// Gera o mascote animado ("avatar falando") usado como bolha no canto do
// vídeo de treinamento. Desenhado como formas vetoriais simples (via Satori,
// o mesmo motor já usado pra gerar os slides em src/lib/slides.tsx) em vez de
// gerado por IA — assim fica 100% gratuito, ilimitado e sempre idêntico
// entre cenas/vídeos, sem depender de nenhuma API externa pra essa parte.
//
// A "fala" é simulada por troca de frame (boca fechada / boca aberta) num
// ritmo constante enquanto a cena tem narração — a composição em vídeo (via
// FFmpeg) está em src/lib/render.ts. Não é lip-sync real (não segue o
// fonema exato do áudio), mas dá a sensação de personagem falando — o mesmo
// truque usado há anos em vídeos explicativos simples.

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Canvas do PNG gerado (com margem transparente ao redor da bolha, pra dar
// espaço a uma borda/sombra sem cortar) e diâmetro da bolha em si.
const SIZE = 360;
const BUBBLE_DIAMETER = 320;

let fontCache: Buffer | null = null;
async function loadFont(): Promise<Buffer> {
  if (fontCache) return fontCache;
  // Mesma fonte estática usada em slides.tsx — o satori exige pelo menos uma
  // fonte configurada, mesmo quando (como aqui) não há texto de verdade.
  const fontPath = path.join(process.cwd(), "public", "fonts", "Inter-Bold.woff");
  fontCache = await fs.readFile(fontPath);
  return fontCache;
}

function mascotMarkup(mouthOpen: boolean) {
  return (
    <div
      style={{
        width: SIZE,
        height: SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: BUBBLE_DIAMETER,
          height: BUBBLE_DIAMETER,
          borderRadius: BUBBLE_DIAMETER / 2,
          background: "#ffffff",
          border: "8px solid #f4a940",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {/* Capacete de segurança */}
        <div
          style={{
            position: "absolute",
            top: 46,
            width: 190,
            height: 64,
            borderRadius: "95px 95px 20px 20px",
            background: "#f4c93f",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 100,
            width: 212,
            height: 16,
            borderRadius: 8,
            background: "#d9a52a",
            display: "flex",
          }}
        />

        {/* Rosto */}
        <div
          style={{
            position: "absolute",
            top: 112,
            width: 168,
            height: 150,
            borderRadius: 84,
            background: "#ffcf9e",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 44,
          }}
        >
          {/* Olhos */}
          <div style={{ display: "flex", gap: 34 }}>
            <div
              style={{ width: 16, height: 16, borderRadius: 8, background: "#2b2b2b", display: "flex" }}
            />
            <div
              style={{ width: 16, height: 16, borderRadius: 8, background: "#2b2b2b", display: "flex" }}
            />
          </div>

          {/* Boca — o único elemento que muda entre os dois frames */}
          <div
            style={{
              marginTop: mouthOpen ? 24 : 34,
              width: mouthOpen ? 46 : 40,
              height: mouthOpen ? 30 : 8,
              borderRadius: mouthOpen ? 18 : 4,
              background: "#8a3b3b",
              display: "flex",
            }}
          />
        </div>
      </div>
    </div>
  );
}

async function renderMascotFrame(mouthOpen: boolean): Promise<string> {
  const font = await loadFont();
  const svg = await satori(mascotMarkup(mouthOpen), {
    width: SIZE,
    height: SIZE,
    fonts: [{ name: "Inter", data: font, weight: 700, style: "normal" }],
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } });
  const png = resvg.render().asPng();
  const outPath = path.join(os.tmpdir(), `mascot-${mouthOpen ? "open" : "closed"}.png`);
  await fs.writeFile(outPath, png);
  return outPath;
}

let mascotFramesPromise: Promise<{ closedPath: string; openPath: string }> | null = null;

/**
 * Gera (uma única vez por processo — o resultado é sempre idêntico, então o
 * cache em memória evita redesenhar à toa) os dois frames PNG do mascote:
 * boca fechada e boca aberta. Consumidos por src/lib/render.ts para montar a
 * animação de "falando" sobreposta ao vídeo final via FFmpeg.
 */
export function getMascotFrames(): Promise<{ closedPath: string; openPath: string }> {
  if (!mascotFramesPromise) {
    mascotFramesPromise = (async () => {
      const [closedPath, openPath] = await Promise.all([
        renderMascotFrame(false),
        renderMascotFrame(true),
      ]);
      return { closedPath, openPath };
    })();
  }
  return mascotFramesPromise;
}
