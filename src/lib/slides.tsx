import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

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

// Rótulos em português exibidos como badges ao lado do texto da cena.
// Precisa cobrir exatamente KNOWN_ITEMS em src/lib/gemini.ts.
const ITEM_LABELS: Record<string, string> = {
  capacete: "Capacete",
  oculos: "Óculos de proteção",
  luvas: "Luvas",
  colete: "Colete refletivo",
  botina: "Botina de segurança",
  mascara: "Máscara",
  protetor_auricular: "Protetor auricular",
  cinto_seguranca: "Cinto de segurança",
  extintor: "Extintor de incêndio",
  placa_alerta: "Sinalização de risco",
};

// Itens "vestidos" diretamente no boneco (via overlay) vs. itens de contexto
// desenhados como ícone avulso ao lado dele.
const WEARABLE_ITEMS = new Set([
  "capacete",
  "oculos",
  "luvas",
  "colete",
  "botina",
  "mascara",
  "protetor_auricular",
  "cinto_seguranca",
]);

const SKIN = "#f0c090";
const SHIRT_DEFAULT = "#4a6d94";
const PANTS = "#2e4058";
const SHOE_DEFAULT = "#22314a";
const SHOE_ACTIVE = "#c47a1e";
const VEST = "#f4a940";
const VEST_STRIPE = "#fdf6e8";
const HELMET = "#f4c430";
const GLOVE = "#c47a1e";
const MASK = "#eef3f8";
const EARMUFF = "#3a3f4a";

/**
 * Boneco de segurança ilustrado em divs/flexbox (compatível com satori).
 * "Veste" os EPIs recebidos em `items` sobre uma base fixa, então a pose e
 * proporções ficam sempre idênticas entre cenas — só os acessórios mudam.
 */
function Boneco({ items }: { items: string[] }) {
  const has = (key: string) => items.includes(key);

  return (
    <div
      style={{
        width: 380,
        height: 620,
        display: "flex",
        position: "relative",
      }}
    >
      {/* Pernas */}
      <div
        style={{
          position: "absolute",
          left: 118,
          top: 372,
          width: 54,
          height: 168,
          borderRadius: 22,
          background: PANTS,
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 208,
          top: 372,
          width: 54,
          height: 168,
          borderRadius: 22,
          background: PANTS,
          display: "flex",
        }}
      />

      {/* Calçados */}
      <div
        style={{
          position: "absolute",
          left: 104,
          top: 528,
          width: 82,
          height: 34,
          borderRadius: 14,
          background: has("botina") ? SHOE_ACTIVE : SHOE_DEFAULT,
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 194,
          top: 528,
          width: 82,
          height: 34,
          borderRadius: 14,
          background: has("botina") ? SHOE_ACTIVE : SHOE_DEFAULT,
          display: "flex",
        }}
      />

      {/* Braços */}
      <div
        style={{
          position: "absolute",
          left: 42,
          top: 218,
          width: 52,
          height: 172,
          borderRadius: 24,
          background: has("colete") ? VEST : SHIRT_DEFAULT,
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 286,
          top: 218,
          width: 52,
          height: 172,
          borderRadius: 24,
          background: has("colete") ? VEST : SHIRT_DEFAULT,
          display: "flex",
        }}
      />

      {/* Luvas */}
      {has("luvas") && (
        <div
          style={{
            position: "absolute",
            left: 34,
            top: 372,
            width: 68,
            height: 60,
            borderRadius: 30,
            background: GLOVE,
            display: "flex",
          }}
        />
      )}
      {has("luvas") && (
        <div
          style={{
            position: "absolute",
            left: 278,
            top: 372,
            width: 68,
            height: 60,
            borderRadius: 30,
            background: GLOVE,
            display: "flex",
          }}
        />
      )}

      {/* Torso */}
      <div
        style={{
          position: "absolute",
          left: 90,
          top: 210,
          width: 200,
          height: 220,
          borderRadius: 30,
          background: has("colete") ? VEST : SHIRT_DEFAULT,
          display: "flex",
        }}
      />

      {/* Faixas refletivas do colete */}
      {has("colete") && (
        <div
          style={{
            position: "absolute",
            left: 90,
            top: 262,
            width: 200,
            height: 20,
            background: VEST_STRIPE,
            display: "flex",
          }}
        />
      )}
      {has("colete") && (
        <div
          style={{
            position: "absolute",
            left: 90,
            top: 366,
            width: 200,
            height: 20,
            background: VEST_STRIPE,
            display: "flex",
          }}
        />
      )}

      {/* Cinto de segurança (faixa diagonal sobre o torso) */}
      {has("cinto_seguranca") && (
        <div
          style={{
            position: "absolute",
            left: 108,
            top: 300,
            width: 240,
            height: 26,
            borderRadius: 10,
            background: "#d64545",
            transform: "rotate(28deg)",
            display: "flex",
          }}
        />
      )}

      {/* Protetor auricular (haste + conchas) */}
      {has("protetor_auricular") && (
        <div
          style={{
            position: "absolute",
            left: 100,
            top: 70,
            width: 180,
            height: 10,
            borderRadius: 5,
            background: EARMUFF,
            display: "flex",
          }}
        />
      )}
      {has("protetor_auricular") && (
        <div
          style={{
            position: "absolute",
            left: 74,
            top: 108,
            width: 36,
            height: 46,
            borderRadius: 14,
            background: EARMUFF,
            display: "flex",
          }}
        />
      )}
      {has("protetor_auricular") && (
        <div
          style={{
            position: "absolute",
            left: 270,
            top: 108,
            width: 36,
            height: 46,
            borderRadius: 14,
            background: EARMUFF,
            display: "flex",
          }}
        />
      )}

      {/* Cabeça */}
      <div
        style={{
          position: "absolute",
          left: 130,
          top: 60,
          width: 120,
          height: 120,
          borderRadius: 60,
          background: SKIN,
          display: "flex",
        }}
      />

      {/* Máscara */}
      {has("mascara") && (
        <div
          style={{
            position: "absolute",
            left: 150,
            top: 128,
            width: 80,
            height: 46,
            borderRadius: 20,
            background: MASK,
            display: "flex",
          }}
        />
      )}

      {/* Óculos de proteção */}
      {has("oculos") && (
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 104,
            width: 100,
            height: 26,
            borderRadius: 13,
            background: "#8fb4dd",
            display: "flex",
          }}
        />
      )}

      {/* Capacete */}
      {has("capacete") && (
        <div
          style={{
            position: "absolute",
            left: 118,
            top: 34,
            width: 144,
            height: 66,
            borderRadius: 40,
            background: HELMET,
            display: "flex",
          }}
        />
      )}
      {has("capacete") && (
        <div
          style={{
            position: "absolute",
            left: 110,
            top: 82,
            width: 160,
            height: 16,
            borderRadius: 8,
            background: HELMET,
            display: "flex",
          }}
        />
      )}
    </div>
  );
}

// Ícones avulsos para itens de "contexto" que não ficam no corpo do boneco.
function ContextIcon({ itemKey }: { itemKey: string }) {
  if (itemKey === "extintor") {
    return (
      <div style={{ display: "flex", position: "relative", width: 70, height: 130 }}>
        <div
          style={{
            position: "absolute",
            left: 10,
            top: 24,
            width: 50,
            height: 96,
            borderRadius: 16,
            background: "#c93c3c",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 26,
            top: 0,
            width: 18,
            height: 28,
            borderRadius: 6,
            background: "#8a8f98",
            display: "flex",
          }}
        />
      </div>
    );
  }
  // placa_alerta
  return (
    <div
      style={{
        display: "flex",
        width: 96,
        height: 96,
        borderRadius: 16,
        background: "#f4c430",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", color: "#3a2c00", fontSize: 60, fontWeight: 700 }}>
        !
      </div>
    </div>
  );
}

interface SlideInput {
  sceneNumber: number;
  totalScenes: number;
  screenText: string;
  projectTitle: string;
  items?: string[];
}

/**
 * Gera um slide (1920x1080) em PNG para uma cena: boneco de segurança
 * ilustrado (vestindo os EPIs da cena) à esquerda, texto e badges dos itens
 * à direita, barra de progresso e identificação da cena/projeto.
 */
export async function generateSlideImage(input: SlideInput): Promise<string> {
  const font = await loadFont();
  const items = input.items ?? [];
  const wearable = items.filter((i) => WEARABLE_ITEMS.has(i));
  const contextItems = items.filter((i) => !WEARABLE_ITEMS.has(i));
  const progress = Math.min(1, input.sceneNumber / input.totalScenes);

  const markup = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "linear-gradient(135deg, #0f2c4c 0%, #143a63 100%)",
        fontFamily: "Inter",
        position: "relative",
        padding: "0",
      }}
    >
      {/* Elementos decorativos de fundo */}
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

      {/* Cabeçalho */}
      <div
        style={{
          display: "flex",
          padding: "56px 80px 0 80px",
          color: "#8fb4dd",
          fontSize: 30,
          letterSpacing: 2,
        }}
      >
        {`CENA ${input.sceneNumber} / ${input.totalScenes}`}
      </div>

      {/* Corpo principal: boneco + texto */}
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          padding: "0 100px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: 460,
          }}
        >
          <Boneco items={wearable} />
          {contextItems.length > 0 && (
            <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
              {contextItems.map((key) => (
                <ContextIcon key={key} itemKey={key} />
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            paddingLeft: 72,
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1.3,
              maxWidth: 1180,
            }}
          >
            {input.screenText}
          </div>

          {items.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                marginTop: 48,
                maxWidth: 1180,
              }}
            >
              {items.map((key) => (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    padding: "14px 28px",
                    borderRadius: 30,
                    background: "rgba(255,255,255,0.12)",
                    color: "#dcebfa",
                    fontSize: 28,
                  }}
                >
                  {ITEM_LABELS[key] ?? key}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rodapé: título + barra de progresso */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 80px 56px 80px",
        }}
      >
        <div style={{ display: "flex", color: "#5f88bb", fontSize: 26, marginBottom: 20 }}>
          {input.projectTitle}
        </div>
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 10,
            borderRadius: 5,
            background: "rgba(255,255,255,0.12)",
          }}
        >
          <div
            style={{
              display: "flex",
              width: `${Math.round(progress * 100)}%`,
              height: "100%",
              borderRadius: 5,
              background: "#f4a940",
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
