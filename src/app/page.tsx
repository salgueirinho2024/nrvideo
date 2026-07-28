"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface Voice {
  id: string;
  label: string;
}

interface ProjectSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Na fila",
  generating_script: "Gerando roteiro...",
  generating_assets: "Gerando áudio e imagens...",
  rendering: "Renderizando...",
  done: "Concluído",
  error: "Erro",
};

function MiniSpinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        border: "2px solid rgba(124,224,138,0.25)",
        borderTopColor: "#7be08a",
        borderRadius: "50%",
        animation: "nrvideo-spin 0.8s linear infinite",
        marginRight: 6,
        verticalAlign: "middle",
      }}
    />
  );
}

export default function HomePage() {
  const router = useRouter();
  const [sourceText, setSourceText] = useState("");
  const [voice, setVoice] = useState("pt-BR-FranciscaNeural");
  const [targetMinutes, setTargetMinutes] = useState(5);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/voices")
      .then((r) => r.json())
      .then((d) => setVoices(d.voices || []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let stop = false;
    async function loadProjects() {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json().catch(() => null);
        if (stop || !data) return;
        setProjects(data.projects || []);
      } catch {
        // silencioso: próxima rodada tenta de novo
      } finally {
        if (!stop) setTimeout(loadProjects, 4000);
      }
    }
    loadProjects();
    return () => {
      stop = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (sourceText.trim().length < 30) {
      setError("Cole o texto da NR (mínimo de 30 caracteres).");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText, voice, targetMinutes }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao criar o projeto.");
      }
      router.push(`/projects/${data.projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 30, marginBottom: 4 }}>
        Gerador de Treinamentos NR
      </h1>
      <p style={{ color: "#9fb0c9", marginBottom: 32, fontSize: 15 }}>
        Cole o texto de uma Norma Regulamentadora e gere automaticamente um
        vídeo de treinamento com roteiro, narração e slides.
      </p>

      <form onSubmit={handleSubmit}>
        <textarea
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Cole aqui o texto da NR (ex: NR-35 Trabalho em Altura)..."
          rows={12}
          style={{
            width: "100%",
            padding: 16,
            borderRadius: 8,
            border: "1px solid #1e2c45",
            background: "#101a2c",
            color: "#e8edf6",
            fontSize: 14,
            fontFamily: "inherit",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <label style={{ fontSize: 13, color: "#9fb0c9" }}>
            Voz da narração
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              style={{
                display: "block",
                marginTop: 6,
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid #1e2c45",
                background: "#101a2c",
                color: "#e8edf6",
                fontSize: 14,
              }}
            >
              {(voices.length
                ? voices
                : [{ id: voice, label: "Padrão" }]
              ).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            disabled={loading}
            style={{
              marginLeft: "auto",
              padding: "12px 28px",
              borderRadius: 8,
              border: "none",
              background: loading ? "#3a5c34" : "#2f7d3f",
              color: "#fff",
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Gerando..." : "Gerar vídeo"}
          </button>
        </div>

        {error && (
          <p style={{ color: "#ff8080", marginTop: 12, fontSize: 14 }}>
            {error}
          </p>
        )}
      </form>

      {projects.length > 0 && (
        <>
          <style>{`@keyframes nrvideo-spin { to { transform: rotate(360deg); } }`}</style>
          <h2
            style={{
              fontSize: 14,
              letterSpacing: 1.5,
              color: "#9fb0c9",
              textTransform: "uppercase",
              marginTop: 48,
            }}
          >
            Projetos recentes
          </h2>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 12,
            }}
          >
            {projects.map((p) => {
              const inProgress = p.status !== "done" && p.status !== "error";
              return (
                <a
                  key={p.id}
                  href={`/projects/${p.id}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: "#101a2c",
                    border: "1px solid #1e2c45",
                    borderRadius: 8,
                    padding: 14,
                    color: "#e8edf6",
                    textDecoration: "none",
                    fontSize: 14,
                  }}
                >
                  <span>{p.title}</span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      color:
                        p.status === "error"
                          ? "#ff8080"
                          : p.status === "done"
                          ? "#7be08a"
                          : "#f5b301",
                    }}
                  >
                    {inProgress && <MiniSpinner />}
                    {STATUS_LABELS[p.status] ?? p.status}
                  </span>
                </a>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
