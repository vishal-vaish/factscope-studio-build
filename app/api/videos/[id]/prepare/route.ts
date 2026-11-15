import { NextResponse } from "next/server";
import { db, videos } from "@/lib/db";
import { eq } from "drizzle-orm";
import { productionSchema } from "@/lib/production-schema";
import { getWorkflowValidation } from "@/lib/comfyui/workflow-builder";
import { getWorkflowConfigurationStatus } from "@/lib/comfyui/config";
import { requireLocalSameOrigin } from "@/lib/comfyui/request-guard";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalSameOrigin(request);
  if (blocked) return NextResponse.json({ validation: { valid: false, failures: [blocked], warnings: [] } }, { status: 403 });
  const { id } = await params;
  const video = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  if (!video.production) return NextResponse.json({ validation: { valid: false, failures: ["Import valid Production JSON before preparing a workflow."], warnings: [] }, configuration: getWorkflowConfigurationStatus() }, { status: 400 });
  const production = productionSchema.safeParse(JSON.parse(video.production));
  if (!production.success) return NextResponse.json({ validation: { valid: false, failures: production.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`), warnings: [] } }, { status: 400 });
  const result = await getWorkflowValidation(production.data);
  return NextResponse.json({ validation: result.validation, workflow: result.workflow, configuration: getWorkflowConfigurationStatus() }, { status: result.validation.valid ? 200 : 422 });
}
