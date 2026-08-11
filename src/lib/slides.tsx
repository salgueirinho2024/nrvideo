import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { detectImageFormat } from "./image-format";

const WIDTH = 1920;
const HEIGHT = 1080;

let fontCache: Buffer | null = null;

async function loadFont(): Promise<Buffer> {
  if (fontCache) return fontCache;
  // Fonte estática incluída no projeto (ver public/fonts) para não depender de rede em runtime.
  // Formato WOFF (o parser de fontes usado pelo satori/opentype.js lê WOFF nativamente).
  const fontPath = path.join(process.cwd(), "public", "fonts", "Inter-Bold.woff");
  fontCache = await fs.readFile(fontPath);
  return fontCache;
}

interface SlideInput {
  sceneNumber: number;
  totalScenes: number;
  screenText: string;
  // Texto integral narrado nesta cena (o que o TTS efetivamente fala).
  // Exibido como legenda na parte inferior do slide. Opcional para não
  // quebrar chamadas existentes, mas o pipeline sempre deve enviar.
  narrationText?: string | null;
  projectTitle: string;
  // Caminho local da imagem cartoon gerada pela IA para esta cena (PNG ou
  // JPEG, ver src/lib/image-gen.ts e src/lib/image-format.ts). Opcional: se
  // faltar/falhar, o slide é renderizado só com o texto, sem quebrar o vídeo.
  imagePath?: string | null;
  // Quando true, gera um PNG com fundo TRANSPARENTE (sem imagem embutida,
  // sem gradiente de fundo) contendo só cabeçalho/texto/legenda/rodapé —
  // pensado para ser sobreposto, no FFmpeg, em cima de um vídeo de banco
  // real (ver src/lib/stock-video.ts e renderSceneClipVideo em render.ts),
  // que já é o "fundo" da cena nesse caso. `imagePath` é ignorado quando
  // essa flag está ligada.
  transparentBackground?: boolean;
}

/**
 * Gera um slide (1920x1080) em PNG para uma cena: ilustração cartoon gerada
 * por IA à esquerda (com base no assunto da cena), texto e progresso à
 * direita/abaixo.
 */
export async function generateSlideImage(input: SlideInput): Promise<string> {
  const font = await loadFont();
  const progress = Math.min(1, input.sceneNumber / input.totalScenes);
  const transparent = input.transparentBackground ?? false;

  let imageDataUri: string | null = null;
  if (input.imagePath && !transparent) {
    try {
      const buf = await fs.readFile(input.imagePath);
      // O Pollinations às vezes devolve JPEG mesmo quando a extensão salva é
      // .png. Rotular o buffer errado na data URI faz o satori/resvg falhar
      // em decodificar em silêncio — o slide "renderiza" normalmente, só que
      // sem a ilustração. Detectar pelos magic bytes evita esse descompasso.
      const { mime } = detectImageFormat(buf);
      imageDataUri = `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      imageDataUri = null;
    }
  }

  // O scrim escuro (gradiente que garante legibilidade do texto) e a
  // ausência dos círculos decorativos fazem sentido tanto quando há uma
  // ilustração de fundo quanto quando o fundo é transparente (nesse caso,
  // vai existir um vídeo real por baixo, no compositing do FFmpeg).
  const showScrim = Boolean(imageDataUri) || transparent;

  const markup = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: transparent
          ? "transparent"
          : imageDataUri
          ? "#0f2c4c"
          : "linear-gradient(135deg, #0f2c4c 0%, #143a63 100%)",
        fontFamily: "Inter",
        position: "relative",
        padding: "0",
      }}
    >
      {/* Ilustração da cena como fundo de tela inteira. Nunca renderizada em
          modo transparente — nesse caso o "fundo" é um vídeo real composto
          depois, no FFmpeg (ver renderSceneClipVideo em render.ts). */}
      {imageDataUri && (
        <img
          src={imageDataUri}
          width={WIDTH}
          height={HEIGHT}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            objectFit: "cover",
          }}
        />
      )}

      {/* Scrim escuro sobre a imagem (ou sobre o vídeo, em modo
          transparente) para o texto continuar legível em qualquer cena,
          mais forte nas bordas superior/inferior (onde ficam cabeçalho,
          legenda e rodapé) e mais leve no centro. */}
      {showScrim && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(8,18,32,0.75) 0%, rgba(8,18,32,0.15) 22%, rgba(8,18,32,0.15) 55%, rgba(8,18,32,0.88) 100%)",
          }}
        />
      )}

      {/* Elementos decorativos de fundo — só quando não há ilustração NEM
          vídeo, para não competir visualmente com a imagem/vídeo da cena. */}
      {!showScrim && (
        <>
          <div
            style={{
              position: "absolute",
              left: -140,
              top: -160,
              width: 520,
              height: 520,
              borderRadius: 260,
              background: "rgba(255,255,255,0.04)",
              display: "flex",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -180,
              bottom: -220,
              width: 620,
              height: 620,
              borderRadius: 310,
              background: "rgba(255,255,255,0.035)",
              display: "flex",
            }}
          />
        </>
      )}

      {/* Cabeçalho: numeração da cena com selo de marca (barrinha colorida +
          maiúsculas espaçadas), consistente com a intro/marca Previna-se. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "56px 80px 0 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 8,
            height: 28,
            borderRadius: 4,
            background: "#f4a940",
            marginRight: 16,
          }}
        />
        <div
          style={{
            display: "flex",
            color: "#c8def4",
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: 3,
          }}
        >
          {`CENA ${input.sceneNumber} DE ${input.totalScenes}`}
        </div>
      </div>

      {/* Corpo principal: título da cena centralizado sobre a ilustração de
          fundo (ou sobre o gradiente, quando não há imagem). Sombra de
          texto (em vez de só a caixa escura por trás) pra parecer título de
          verdade, não uma legenda genérica. */}
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "flex-end",
          padding: "24px 100px",
        }}
      >
        <div
          style={{
            display: "flex",
            color: "#ffffff",
            fontSize: 62,
            fontWeight: 700,
            lineHeight: 1.25,
            letterSpacing: -0.5,
            maxWidth: 1400,
            textShadow: "0 4px 18px rgba(0,0,0,0.55)",
          }}
        >
          {input.screenText}
        </div>
      </div>

      {/* Legenda: texto integral narrado nesta cena (fica visível durante
          toda a duração do áudio, já que a imagem do slide é estática por
          cena inteira — ver src/lib/render.ts). Não é sincronizada palavra a
          palavra (o TTS usado não devolve timestamps por palavra), mas cobre
          a cena inteira, como legenda de filme por frase. Estilo "pílula"
          centralizada (padrão de legenda profissional tipo YouTube/Netflix)
          em vez da caixa retangular de borda a borda anterior. */}
      {input.narrationText && (
        <div style={{ display: "flex", justifyContent: "center", margin: "0 80px 30px 80px" }}>
          <div
            style={{
              display: "flex",
              padding: "20px 40px",
              borderRadius: 14,
              background: "rgba(6,14,26,0.72)",
              boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            }}
          >
            <div
              style={{
                display: "flex",
                color: "#f8fafc",
                fontSize: 30,
                fontWeight: 700,
                lineHeight: 1.45,
                textAlign: "center",
                maxWidth: 1600,
              }}
            >
              {input.narrationText}
            </div>
          </div>
        </div>
      )}

      {/* Rodapé: marca + título do projeto + barra de progresso */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 80px 48px 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#f4a940",
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 1,
              marginRight: 14,
            }}
          >
            {"PREVINA-SE"}
          </div>
          <div
            style={{
              display: "flex",
              color: "#8fb4dd",
              fontSize: 24,
              fontWeight: 700,
              opacity: 0.85,
            }}
          >
            {`· ${input.projectTitle}`}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 10,
            borderRadius: 5,
            background: "rgba(255,255,255,0.18)",
          }}
        >
          <div
            style={{
              display: "flex",
              width: `${Math.round(progress * 100)}%`,
              height: "100%",
              borderRadius: 5,
              background: "linear-gradient(90deg, #f4a940 0%, #f7c46c 100%)",
            }}
          />
        </div>
      </div>
    </div>
  );

  const svg = await satori(markup, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [{ name: "Inter", data: font, weight: 700, style: "normal" }],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  });
  const png = resvg.render().asPng();

  const outPath = path.join(os.tmpdir(), `slide-${nanoid(8)}.png`);
  await fs.writeFile(outPath, png);
  return outPath;
}
