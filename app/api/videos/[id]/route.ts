import { NextResponse } from "next/server";
import { db, videos } from "@/lib/db";
import { eq } from "drizzle-orm";
import { productionSchema } from "@/lib/production-schema";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const video = db.select().from(videos).where(eq(videos.id, id)).get(); if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 }); return NextResponse.json({ ...video, settings: JSON.parse(video.settings), production: video.production ? JSON.parse(video.production) : null }); }
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const video = db.select().from(videos).where(eq(videos.id, id)).get(); if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 }); const body = await request.json();
 if (body.action === "delete") { db.delete(videos).where(eq(videos.id, id)).run(); return NextResponse.json({ ok: true }); }
 if (body.action === "import") { const result = productionSchema.safeParse(body.production); if (!result.success) return NextResponse.json({ error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 }); if (result.data.projectId !== id) return NextResponse.json({ error: ["projectId: Must match this saved video project."] }, { status: 400 }); db.update(videos).set({ production: JSON.stringify(result.data), status: "Ready for Workflow Validation", updatedAt: Date.now() }).where(eq(videos.id, id)).run(); return NextResponse.json({ ok: true, production: result.data }); }
 return NextResponse.json({ error: "Unsupported action" }, { status: 400 }); }
