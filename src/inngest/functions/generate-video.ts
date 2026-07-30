import { inngest } from "../client";
import { db } from "@/db";
import { projects, scenes, scriptLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateScript } from "@/lib/gemini";
import { synthesizeSpeech } from "@/lib/tts";
import { generateSceneImage } from "@/lib/image-gen";
import { fetchStockVideo } from "@/lib/stock-video";
import { generateSlideImage } from "@/lib/slides";
import { uploadFile } from "@/lib/storage";
import { downloadToTemp } from "@/lib/download";
import {
  getAudioDuration,
  renderSceneClip,
  renderSceneClipVideo,
  concatFinalVideo,
} from "@/lib/render";
import { buildSceneLipsync } from "@/lib/lipsync/lipsync-service";
import type { MouthCue } from "@/lib/lipsync/types";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";

export const generateVideoFunction = inngest.createFunction(
  {
    id: "generate-nr-video",
    retries: 2,
    // Se todas as tentativas falharem, marca o projeto como erro em vez de
    // deixá-lo travado indefinidamente em "generating_script"/"rendering".
    onFailure: async ({ event }) => {
      const original = event.data.event as {
        data: { projectId: string };
      };
      const projectId = original?.data?.projectId;
      if (!projectId) return;
      await db
        .update(projects)
        .set({
          status: "error",
          errorMessage:
            "Falha ao gerar o vídeo após múltiplas tentativas. Veja os logs do Inngest para detalhes.",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
    },
  },
  { event: "nr-video/generate.requested" },
  async ({ event, step }) => {
    const { projectId } = event.data as { projectId: string };

    // 1. Gerar roteiro com Gemini e persistir as cenas no banco
    const script = await step.run("generate-script", async () => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) throw new Error("Projeto não encontrado.");

      await db
        .update(projects)
        .set({ status: "generating_script", updatedAt: new Date() })
        .where(eq(projects.id, projectId));

      const result = await generateScript(project.sourceText, project.targetMinutes);

      await db.insert(scriptLogs).values({
        projectId,
        rawResponse: result.raw as object,
      });

      const insertedScenes = await db
        .insert(scenes)
        .values(
          result.scenes.map((s) => ({
            projectId,
            order: s.order,
            narrationText: s.narrationText,
            screenText: s.screenText,
            imagePrompt: s.imagePrompt,
            highlight: s.highlight,
            useStockVideo: s.useStockVideo,
            videoSearchQuery: s.videoSearchQuery || null,
          }))
        )
        .returning({ id: scenes.id, order: scenes.order });

      await db
        .update(projects)
        .set({
          title: result.title,
          status: "generating_assets",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      return {
        title: result.title,
        voice: project.voice,
        sceneIds: insertedScenes
          .sort((a, b) => a.order - b.order)
          .map((s) => s.id),
      };
    });

    // 2. Para cada cena: gerar áudio (TTS) + slide (ou vídeo de banco +
    //    overlay, para as até 3 cenas marcadas useStockVideo), e enviar
    //    para o Blob
    const sceneAssets: {
      audioUrl: string;
      slideUrl: string;
      highlight: boolean;
      mediaType: "image" | "video";
      sceneVideoUrl: string | null;
      // Timeline real de boca (fonemas via Rhubarb/heurística), calculada
      // uma vez por cena em generate-assets-scene-N e reaproveitada em
      // render-clip-scene-N — ver src/lib/lipsync/.
      mouthCues: MouthCue[];
    }[] = [];
    for (let i = 0; i < script.sceneIds.length; i++) {
      const sceneId = script.sceneIds[i];
      const assets = await step.run(`generate-assets-scene-${i}`, async () => {
        const scene = await db.query.scenes.findFirst({
          where: eq(scenes.id, sceneId),
        });
        if (!scene) throw new Error(`Cena ${sceneId} não encontrada.`);

        // --- Áudio (TTS) ---
        const audioPath = await synthesizeSpeech(
          scene.narrationText,
          script.voice
        );
        const duration = await getAudioDuration(audioPath);

        // --- Lip sync por fonemas reais (ver src/lib/lipsync/) ---
        // Precisa rodar AQUI, com o áudio ainda em disco local — depois do
        // upload pro Blob, esse tmp file é apagado. O resultado (mouthCues
        // já mapeadas pros 3 estados de boca existentes) viaja junto com os
        // outros assets da cena até a etapa de render.
        const lipsyncResult = await buildSceneLipsync({
          sceneId: scene.id,
          audioFilePath: audioPath,
          narrationText: scene.narrationText,
          durationSeconds: duration,
        });

        let visemeTimelineUrl: string | null = null;
        try {
          const timelinePath = path.join(os.tmpdir(), `${scene.id}-visemes.json`);
          await fsPromises.writeFile(
            timelinePath,
            JSON.stringify(lipsyncResult.rawTimeline, null, 2)
          );
          visemeTimelineUrl = await uploadFile(
            timelinePath,
            `${projectId}/scene-${scene.order}-visemes.json`,
            "application/json"
          );
          await fsPromises.unlink(timelinePath).catch(() => undefined);
        } catch (err) {
          // Puramente para debug/QA — nunca deve derrubar a geração do vídeo.
          console.error(`Falha ao subir timeline de visemas da cena ${scene.order}:`, err);
        }

        const audioUrl = await uploadFile(
          audioPath,
          `${projectId}/scene-${scene.order}-audio.mp3`,
          "audio/mpeg"
        );
        await fsPromises.unlink(audioPath).catch(() => undefined);

        // --- Vídeo de banco (até 3 cenas do roteiro, ver gemini.ts) ---
        // Tentado ANTES da ilustração estática: se der certo, a cena usa o
        // vídeo real como fundo (renderSceneClipVideo) e nem precisa da
        // ilustração cartoon. Se falhar por qualquer motivo (sem
        // PEXELS_API_KEY, sem resultado pra query, rede etc.), cai de volta
        // pro fluxo normal de imagem — mesma filosofia de resiliência já
        // usada pra falha de geração de imagem (ver imageError abaixo).
        let sceneVideoUrl: string | null = null;
        let videoError: string | null = null;
        if (scene.useStockVideo && scene.videoSearchQuery) {
          try {
            const stockVideoPath = await fetchStockVideo(scene.videoSearchQuery);
            sceneVideoUrl = await uploadFile(
              stockVideoPath,
              `${projectId}/scene-${scene.order}-stock-video.mp4`,
              "video/mp4"
            );
            await fsPromises.unlink(stockVideoPath).catch(() => undefined);
          } catch (err) {
            videoError = err instanceof Error ? err.message : String(err);
            console.error(`Falha ao buscar vídeo de banco da cena ${scene.order}:`, err);
          }
        }

        if (sceneVideoUrl) {
          // --- Overlay de texto transparente (cena com vídeo de banco) ---
          const overlayPath = await generateSlideImage({
            sceneNumber: scene.order,
            totalScenes: script.sceneIds.length,
            screenText: scene.screenText,
            narrationText: scene.narrationText,
            projectTitle: script.title,
            transparentBackground: true,
          });
          const overlayUrl = await uploadFile(
            overlayPath,
            `${projectId}/scene-${scene.order}-overlay.png`,
            "image/png"
          );
          await fsPromises.unlink(overlayPath).catch(() => undefined);

          await db
            .update(scenes)
            .set({
              audioUrl,
              audioDurationSeconds: Math.ceil(duration),
              sceneVideoUrl,
              slideImageUrl: overlayUrl,
              videoError: null,
              assetsReady: true,
              lipsyncSource: lipsyncResult.timelineSource,
              detectedEmotion: lipsyncResult.emotion,
              visemeTimelineUrl,
            })
            .where(eq(scenes.id, sceneId));

          return {
            audioUrl,
            slideUrl: overlayUrl,
            highlight: scene.highlight,
            mediaType: "video" as const,
            sceneVideoUrl,
            mouthCues: lipsyncResult.mouthCues,
          };
        }

        // --- Ilustração cartoon gerada por IA a partir do assunto da cena ---
        let sceneImagePath: string | null = null;
        let imageError: string | null = null;
        try {
          sceneImagePath = await generateSceneImage(scene.imagePrompt ?? "");
        } catch (err) {
          // Não derruba o vídeo inteiro se a geração de imagem falhar numa
          // cena específica: o slide segue sem ilustração para essa cena.
          // O motivo fica salvo em scenes.imageError (ver abaixo) pra
          // aparecer na UI em vez de só sumir num log.
          imageError = err instanceof Error ? err.message : String(err);
          console.error(`Falha ao gerar imagem da cena ${scene.order}:`, err);
        }

        // --- Slide (imagem final composta) ---
        const slidePath = await generateSlideImage({
          sceneNumber: scene.order,
          totalScenes: script.sceneIds.length,
          screenText: scene.screenText,
          narrationText: scene.narrationText,
          projectTitle: script.title,
          imagePath: sceneImagePath,
        });
        const slideUrl = await uploadFile(
          slidePath,
          `${projectId}/scene-${scene.order}-slide.png`,
          "image/png"
        );
        await fsPromises.unlink(slidePath).catch(() => undefined);
        if (sceneImagePath) {
          await fsPromises.unlink(sceneImagePath).catch(() => undefined);
        }

        await db
          .update(scenes)
          .set({
            audioUrl,
            audioDurationSeconds: Math.ceil(duration),
            slideImageUrl: slideUrl,
            imageError,
            videoError,
            assetsReady: true,
            lipsyncSource: lipsyncResult.timelineSource,
            detectedEmotion: lipsyncResult.emotion,
            visemeTimelineUrl,
          })
          .where(eq(scenes.id, sceneId));

        return {
          audioUrl,
          slideUrl,
          highlight: scene.highlight,
          mediaType: "image" as const,
          sceneVideoUrl: null,
          mouthCues: lipsyncResult.mouthCues,
        };
      });
      sceneAssets.push(assets);
    }

    // 3. Renderizar cada cena como um clipe mp4 (imagem + áudio) e subir
    //    para o Blob — UMA etapa do Inngest por cena. Isso é o que torna
    //    vídeos longos (muitas cenas) viáveis em serverless: se a function
    //    tem um `maxDuration` limitado, renderizar tudo de uma vez numa
    //    única invocação estouraria o tempo; renderizando cena a cena, cada
    //    etapa é curta e, se falhar, o Inngest só reexecuta aquela etapa.
    await step.run("mark-rendering", async () => {
      await db
        .update(projects)
        .set({ status: "rendering", updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    });

    const clipUrls: string[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      const asset = sceneAssets[i];
      const clipUrl = await step.run(`render-clip-scene-${i}`, async () => {
        const audioPath = await downloadToTemp(asset.audioUrl, "mp3");

        let clipPath: string;
        if (asset.mediaType === "video" && asset.sceneVideoUrl) {
          const videoPath = await downloadToTemp(asset.sceneVideoUrl, "mp4");
          const overlayImagePath = await downloadToTemp(asset.slideUrl, "png");

          clipPath = await renderSceneClipVideo(
            { videoPath, overlayImagePath, audioPath },
            i
          );

          await Promise.all([
            fsPromises.unlink(videoPath).catch(() => undefined),
            fsPromises.unlink(overlayImagePath).catch(() => undefined),
          ]);
        } else {
          const imagePath = await downloadToTemp(asset.slideUrl, "png");

          clipPath = await renderSceneClip(
            { imagePath, audioPath, highlight: asset.highlight, mouthCues: asset.mouthCues },
            i
          );

          await fsPromises.unlink(imagePath).catch(() => undefined);
        }

        const url = await uploadFile(
          clipPath,
          `${projectId}/scene-${i}-clip.mp4`,
          "video/mp4"
        );

        await Promise.all([
          fsPromises.unlink(audioPath).catch(() => undefined),
          fsPromises.unlink(clipPath).catch(() => undefined),
        ]);

        return url;
      });
      clipUrls.push(clipUrl);
    }

    // 4. Concatenar os clipes já renderizados num único mp4 final ("-c
    //    copy", sem re-encode — rápido mesmo com dezenas de clipes) e subir
    //    para o Blob.
    const videoUrl = await step.run("concat-and-upload-video", async () => {
      const localClipPaths: string[] = [];
      for (const url of clipUrls) {
        localClipPaths.push(await downloadToTemp(url, "mp4"));
      }

      const finalVideoPath = await concatFinalVideo(localClipPaths);
      const url = await uploadFile(
        finalVideoPath,
        `${projectId}/final-video.mp4`,
        "video/mp4"
      );

      await Promise.all(
        localClipPaths.map((p) => fsPromises.unlink(p).catch(() => undefined))
      );
      await fsPromises.unlink(finalVideoPath).catch(() => undefined);

      return url;
    });

    // 5. Finalizar
    await step.run("finalize", async () => {
      await db
        .update(projects)
        .set({ status: "done", videoUrl, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    });

    return { projectId, videoUrl };
  }
);
