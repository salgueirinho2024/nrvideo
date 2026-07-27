"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const STEPS = [
  { key: "pending", label: "Na fila" },
  { key: "generating_script", label: "Roteiro (Gemini)" },
  { key: "generating_assets", label: "Áudio e slides" },
  { key: "rendering", label: "Renderização (FFmpeg)" },
  { key: "done", label: "Concluído" },
];

interface Scene {
  id: string;
  order: number;
  narrationText: string;
  screenText: string;
  assetsReady: boolean;
}

interface Project {
  id: string;
  title: string;
  status: string;
  errorMessage: string | null;
  videoUrl: string | null;
}

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/projects/${params.id}`);
        const data = await res.json().catch(() => null);
        if (stop) return;
        if (!res.ok) {
          setFetchError(
            (data && data.error) || `Erro ${res.status} ao carregar o projeto.`
          );
          setTimeout(poll, 4000);
          return;
        }
        setFetchError(null);
        setProject(data.project);
        setScenes(data.scenes || []);
        if (data.project.status !== "done" && data.project.status !== "error") {
          setTimeout(poll, 4000);
        }
      } catch (err) {
        if (stop) return;
        setFetchError(
          err instanceof Error ? err.message : "Erro de rede ao carregar o projeto."
        );
        setTimeout(poll, 4000);
      }
    }
    poll();
    return () => {
      stop = true;
    };
  }, [params.id]);

  const stepIndex = project ? STEPS.findIndex((s) => s.key === project.status) : -1;

  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "48px 24px" }}>
      <Link href="/" style={{ color: "#9fb0c9", fontSize: 14 }}>
        ← Voltar
      </Link>

      {!project ? (
        <div style={{ marginTop: 24 }}>
          <p style={{ color: "#9fb0c9" }}>Carregando...</p>
          {fetchError && (
            <div
              style={{
                background: "#2c1414",
                border: "1px solid #5a1f1f",
                color: "#ff8080",
                padding: 16,
                borderRadius: 8,
                marginTop: 12,
                fontSize: 13,
                whiteSpace: "pre-wrap",
              }}
            >
              Erro ao carregar: {fetchError}
              <br />
              Tentando novamente a cada 4s...
            </div>
          )}
        </div>
      ) : (
        <>
          <h1 style={{ fontSize: 28, margin: "16px 0 24px" }}>{project.title}</h1>

          {project.status === "error" ? (
            <div
              style={{
                background: "#2c1414",
                border: "1px solid #5a1f1f",
                color: "#ff8080",
                padding: 16,
                borderRadius: 8,
                marginBottom: 24,
              }}
            >
              {project.errorMessage || "Ocorreu um erro ao gerar o vídeo."}
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, marginBottom: 32, flexWrap: "wrap" }}>
              {STEPS.map((step, i) => (
                <div
                  key={step.key}
                  style={{
                    flex: "1 1 140px",
                    padding: "10px 12px",
                    borderRadius: 8,
                    fontSize: 13,
                    textAlign: "center",
                    background: i <= stepIndex ? "#22361f" : "#101a2c",
                    border: `1px solid ${i <= stepIndex ? "#3a5c34" : "#1e2c45"}`,
                    color: i <= stepIndex ? "#7be08a" : "#5f7196",
                  }}
                >
                  {step.label}
                </div>
              ))}
            </div>
          )}

          {project.videoUrl && (
            <video
              src={project.videoUrl}
              controls
              style={{ width: "100%", borderRadius: 12, marginBottom: 32 }}
            />
          )}

          <h2 style={{ fontSize: 14, letterSpacing: 1.5, color: "#9fb0c9", textTransform: "uppercase" }}>
            Cenas ({scenes.length})
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {scenes.map((s) => (
              <div
                key={s.id}
                style={{
                  background: "#101a2c",
                  border: "1px solid #1e2c45",
                  borderRadius: 8,
                  padding: 14,
                }}
              >
                <div style={{ fontSize: 12, color: "#f5b301", marginBottom: 4 }}>
                  Cena {s.order} {s.assetsReady ? "✓" : "…"}
                </div>
                <div style={{ fontSize: 14, marginBottom: 4 }}>{s.screenText}</div>
                <div style={{ fontSize: 13, color: "#9fb0c9" }}>{s.narrationText}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
