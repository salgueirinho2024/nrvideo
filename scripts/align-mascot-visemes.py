#!/usr/bin/env python3
"""
Alinha e recorta os 8 PNGs de boca (visemas) da mascote gerados por
scripts/generate-mascot-visemes.mjs.

POR QUE ESSE SCRIPT EXISTE:
Cada uma das 8 imagens é gerada independentemente por um modelo
texto-pra-imagem (Cloudflare flux-1-schnell). Mesmo com seed fixa, o
modelo NÃO garante pixel-perfect entre as 8 gerações: a cabeça sai um
pouco maior/menor, um pouco deslocada, ângulo levemente diferente. Sem
correção, o render.ts troca de PNG a cada estado de boca e a mascote
parece "pulando"/"girando" no vídeo final — não é bug de lip sync, é
desalinhamento das imagens-fonte.

O QUE ESTE SCRIPT FAZ:
1. Alinha (ECC, transformação rígida: rotação + translação + escala
   uniforme) as 7 imagens restantes sobre mouth-closed.png, usando só a
   região estável do rosto (testa/olhos/sobrancelhas/capacete) como
   referência — a região da boca fica de fora de propósito, senão o
   alinhamento "puxaria" a boca pra ficar igual e anularia a diferença
   entre visemas.
2. Recorta em close no rosto (esconde diferenças de ombro/mão que só
   aparecem nalgum frame) e aplica máscara circular.
3. Adiciona anel verde/branco (identidade visual) e sombra suave.
4. Salva RGBA (transparência real) em public/mascot/.

COMO RODAR (depois de gerar/regenerar via generate-mascot-visemes.mjs):
    pip install opencv-python-headless numpy pillow
    python3 scripts/align-mascot-visemes.py

Roda 100% local/offline sobre os PNGs já existentes em public/mascot/ —
não chama nenhuma API. Sempre rode isso depois de QUALQUER regeneração
(total ou parcial) de public/mascot/*.png.
"""
import os
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MASCOT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "mascot")
REF_FILE = "mouth-closed.png"
FILES = [
    "mouth-closed.png",
    "mouth-half-teeth.png",
    "mouth-ch-open.png",
    "mouth-wide-open.png",
    "mouth-stretch-e.png",
    "mouth-teeth-lip.png",
    "mouth-round-o.png",
    "mouth-tongue-l.png",
]

# Caixa de crop final (proporcional a uma fonte 1024x1024 — se a resolução
# de geração mudar, ajuste proporcionalmente).
SRC_SIZE = 1024
CROP_BOX = (140, 60, 900, 820)
STABLE_REGION = (150, 0, 874, 430)  # topo do capacete até acima da boca

RING_COLOR = (46, 204, 113, 255)
RING_INNER_COLOR = (255, 255, 255, 255)


def align(ref_gray, gray, bgr, mask):
    warp_matrix = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 5000, 1e-8)
    try:
        _, warp_matrix = cv2.findTransformECC(
            ref_gray, gray, warp_matrix, cv2.MOTION_EUCLIDEAN, criteria, mask, 5
        )
        return cv2.warpAffine(
            bgr, warp_matrix, (SRC_SIZE, SRC_SIZE),
            flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REPLICATE,
        )
    except cv2.error as e:
        print(f"  aviso: alinhamento falhou ({e}), usando original sem realinhar")
        return bgr


def composite_bubble(bgr_1024):
    im = Image.fromarray(cv2.cvtColor(bgr_1024, cv2.COLOR_BGR2RGB))
    im = im.crop(CROP_BOX)
    side = min(im.size)
    im = im.crop((0, 0, side, side))
    SUPER = side * 2
    im = im.resize((SUPER, SUPER), Image.LANCZOS)

    mask = Image.new("L", (SUPER, SUPER), 0)
    d = ImageDraw.Draw(mask)
    pad = 4
    d.ellipse((pad, pad, SUPER - pad, SUPER - pad), fill=255)
    rgba = im.convert("RGBA")
    rgba.putalpha(mask)

    ring_layer = Image.new("RGBA", (SUPER, SUPER), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring_layer)
    outer = SUPER - 2
    green_w = int(SUPER * 0.028)
    white_w = int(SUPER * 0.012)
    rd.ellipse((1, 1, outer, outer), outline=RING_COLOR, width=green_w)
    inset = green_w
    rd.ellipse((1 + inset, 1 + inset, outer - inset, outer - inset), outline=RING_INNER_COLOR, width=white_w)
    combined = Image.alpha_composite(rgba, ring_layer).resize((side, side), Image.LANCZOS)

    shadow_size = side + int(side * 0.078)
    off = (shadow_size - side) // 2
    shadow = Image.new("RGBA", (shadow_size, shadow_size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((off, off + 14, off + side, off + 14 + side), fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(side * 0.018)))
    final = Image.new("RGBA", (shadow_size, shadow_size), (0, 0, 0, 0))
    final.alpha_composite(shadow)
    final.alpha_composite(combined, (off, off))
    return final


def main():
    ref_path = os.path.join(MASCOT_DIR, REF_FILE)
    ref_bgr = cv2.imread(ref_path, cv2.IMREAD_COLOR)
    if ref_bgr is None:
        raise SystemExit(f"Não achei {ref_path} — rode generate-mascot-visemes.mjs primeiro.")
    ref_gray = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY)

    mask = np.zeros((SRC_SIZE, SRC_SIZE), dtype=np.uint8)
    l, t, r, b = STABLE_REGION
    cv2.rectangle(mask, (l, t), (r, b), 255, -1)

    for f in FILES:
        path = os.path.join(MASCOT_DIR, f)
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"pulando {f} (não encontrado)")
            continue
        if f == REF_FILE:
            aligned = ref_bgr
        else:
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            print(f"alinhando {f}...")
            aligned = align(ref_gray, gray, bgr, mask)
        bubble = composite_bubble(aligned)
        bubble.save(path)
        print(f"  -> salvo {path} ({bubble.size[0]}x{bubble.size[1]}, RGBA)")

    print("\nPronto. Confira public/mascot/*.png — os 8 devem parecer a MESMA")
    print("cara/enquadramento, só a boca mudando, dentro de um círculo com anel.")


if __name__ == "__main__":
    main()
