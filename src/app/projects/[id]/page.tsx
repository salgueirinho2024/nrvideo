"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

const STEPS = [
  { key: "pending", label: "Na fila" },
  { key: "generating_script", label: "Roteiro (Gemini)" },
  { key: "generating_assets", label: "Áudio e imagens" },
  { key: "rendering", label: "Renderização (FFmpeg)" },
  { key: "done", label: "Concluído" },
];

const IN_PROGRESS_LABELS: Record<string, string> = {
  pending: "Na fila, aguardando início...",
  generating_script: "Gerando roteiro com IA (Gemini)...",
  generating_assets: "Gerando áudio e imagens cartoon das cenas...",
  rendering: "Renderizando o vídeo final (FFmpeg)...",
};

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: "2px solid rgba(124,224,138,0.25)",
        borderTopColor: "#7be08a",
        borderRadius: "50%",
        animation: "nrvideo-spin 0.8s linear infinite",
        marginRight: 10,
        verticalAlign: "middle",
      }}
    />
  );
}

function VideoWithRetry({ url }: { url: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const MAX_ATTEMPTS = 6;

  function handleError() {
    if (attempt < MAX_ATTEMPTS - 1) {
      // Backoff crescente: o Blob às vezes leva alguns segundos pra
      // propagar a URL recém-criada. Tenta de novo antes de desistir.
      setTimeout(() => setAttempt((a) => a + 1), 1500 * (attempt + 1));
    } else {
      setFailed(true);
    }
  }

  if (failed) {
    return (
      <div
        style={{
          background: "#101a2c",
          border: "1px solid #1e2c45",
          borderRadius: 12,
          padding: 20,
          marginBottom: 32,
          color: "#9fb0c9",
          fontSize: 14,
        }}
      >
        Não consegui carregar o vídeo ainda.{" "}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#7be08a" }}
        >
          Tente abrir o link direto
        </a>{" "}
        ou recarregue a página em alguns segundos.
      </div>
    );
  }

  return (
    <div style={{ position: "relative", marginBottom: 32 }}>
      <video
        key={attempt}
        src={url}
        controls
        onError={handleError}
        style={{ width: "100%", borderRadius: 12, display: "block" }}
      />
    </div>
  );
}
interface Scene {
  id: string;
  order: number;
  narrationText: string;
  screenText: string;
  assetsReady: boolean;
  imageError: string | null;
  // true para as cenas que o Gemini escolheu como as mais importantes do
  // roteiro — recebem um Ken Burns mais dinâmico no vídeo final (ver
  // src/lib/render.ts).
  highlight: boolean;
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
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDelete() {
    if (!project) return;
    if (!confirm(`Apagar o projeto "${project.title}"? Isso remove os arquivos (vídeo, áudio, imagens) e não pode ser desfeito.`)) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error((data && data.error) || `Erro ${res.status} ao apagar o projeto.`);
      }
      router.push("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Erro ao apagar o projeto.");
      setDeleting(false);
    }
  }

  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "48px 24px" }}>
      <Link href="/" style={{ color: "#9fb0c9", fontSize: 14 }}>
        ← Voltar
      </Link>

      {!project ? (
        <div style={{ marginTop: 24 }}>
          <style>{`@keyframes nrvideo-spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ color: "#9fb0c9", display: "flex", alignItems: "center" }}>
            <Spinner /> Carregando...
          </p>
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
          <style>{`
            @keyframes nrvideo-spin { to { transform: rotate(360deg); } }
            @keyframes nrvideo-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
          `}</style>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              margin: "16px 0 24px",
            }}
          >
            <h1 style={{ fontSize: 28, margin: 0 }}>{project.title}</h1>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{
                flexShrink: 0,
                background: "transparent",
                border: "1px solid #5a1f1f",
                color: "#ff8080",
                borderRadius: 8,
                padding: "8px 14px",
                fontSize: 13,
                cursor: deleting ? "default" : "pointer",
                opacity: deleting ? 0.6 : 1,
              }}
            >
              {deleting ? "Apagando..." : "Apagar projeto"}
            </button>
          </div>
          {deleteError && (
            <div
              style={{
                background: "#2c1414",
                border: "1px solid #5a1f1f",
                color: "#ff8080",
                padding: 12,
                borderRadius: 8,
                marginBottom: 16,
                fontSize: 13,
              }}
            >
              {deleteError}
            </div>
          )}

          {project.status !== "done" && project.status !== "error" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "#152615",
                border: "1px solid #2e4a2a",
                borderRadius: 10,
                padding: "14px 18px",
                marginBottom: 24,
                animation: "nrvideo-pulse 2s ease-in-out infinite",
              }}
            >
              <Spinner />
              <span style={{ color: "#7be08a", fontSize: 15, fontWeight: 500 }}>
                {IN_PROGRESS_LABELS[project.status] ?? "Gerando..."}
              </span>
              {project.status === "generating_assets" && scenes.length > 0 && (
                <span style={{ color: "#5f9c6b", fontSize: 13, marginLeft: 10 }}>
                  ({scenes.filter((s) => s.assetsReady).length}/{scenes.length} cenas
                  prontas)
                </span>
              )}
            </div>
          )}

          {project.status === "done" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "#152615",
                border: "1px solid #2e4a2a",
                borderRadius: 10,
                padding: "14px 18px",
                marginBottom: 24,
                color: "#7be08a",
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              ✓ Vídeo pronto!
            </div>
          )}

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

          {project.videoUrl && <VideoWithRetry url={project.videoUrl} />}

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
                <div
                  style={{
                    fontSize: 12,
                    color: "#f5b301",
                    marginBottom: 4,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  Cena {s.order}{" "}
                  {s.assetsReady ? (
                    <span style={{ marginLeft: 6 }}>✓</span>
                  ) : (
                    <span style={{ marginLeft: 8, display: "inline-flex" }}>
                      <Spinner />
                    </span>
                  )}
                  {s.highlight && (
                    <span
                      title="Cena de destaque: recebe um movimento de câmera mais dinâmico no vídeo final"
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        color: "#0b1220",
                        background: "#f5b301",
                        borderRadius: 999,
                        padding: "1px 8px",
                        fontWeight: 600,
                      }}
                    >
                      ★ destaque
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, marginBottom: 4 }}>{s.screenText}</div>
                <div style={{ fontSize: 13, color: "#9fb0c9" }}>{s.narrationText}</div>
                {s.imageError && (
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 6,
                      background: "#2c1414",
                      border: "1px solid #5a1f1f",
                      color: "#ff8080",
                      padding: "8px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  >
                    <span>⚠</span>
                    <span>
                      Ilustração não gerada para esta cena: {s.imageError}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
