import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { desc } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { AVAILABLE_VOICES } from "@/lib/tts";

export async function GET() {
  try {
    const allProjects = await db.query.projects.findMany({
      orderBy: desc(projects.createdAt),
    });
    return NextResponse.json({ projects: allProjects });
  } catch (err) {
    console.error("GET /api/projects falhou:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Erro ao listar projetos.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { sourceText?: string; voice?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido." },
      { status: 400 }
    );
  }

  const sourceText = body.sourceText?.trim();
  if (!sourceText || sourceText.length < 30) {
    return NextResponse.json(
      {
        error:
          "Cole o texto da NR (mínimo de 30 caracteres) para gerar o treinamento.",
      },
      { status: 400 }
    );
  }

  const voice =
    body.voice && AVAILABLE_VOICES.some((v) => v.id === body.voice)
      ? body.voice
      : AVAILABLE_VOICES[0].id;

  try {
    const [project] = await db
      .insert(projects)
      .values({
        title: "Gerando título...",
        sourceText,
        voice,
        status: "pending",
      })
      .returning({ id: projects.id });

    await inngest.send({
      name: "nr-video/generate.requested",
      data: { projectId: project.id },
    });

    return NextResponse.json({ projectId: project.id }, { status: 201 });
  } catch (err) {
    // Loga o erro completo nos logs da Vercel/Inngest para depuração, mas
    // sempre devolve um JSON válido pro frontend não quebrar com
    // "Unexpected end of JSON input" ao tentar ler uma resposta vazia.
    console.error("POST /api/projects falhou:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Falha ao criar o projeto: ${err.message}`
            : "Falha ao criar o projeto.",
      },
      { status: 500 }
    );
  }
}
