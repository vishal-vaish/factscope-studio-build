import { NextResponse } from "next/server";
import { db, videos } from "@/lib/db";
import { eq } from "drizzle-orm";
import { productionSchema } from "@/lib/production-schema";
import { getWorkflowConfigurationStatus } from "@/lib/comfyui/config";
import { loadImportedWorkflow, loadReferenceWorkflow } from "@/lib/workflow/storage";
import { validateImportedApiWorkflow } from "@/lib/workflow/validate-api";
import { isComfyApiWorkflow } from "@/lib/workflow/inspect";
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
  const imported = await loadImportedWorkflow(id, "api");
  const reference = await loadReferenceWorkflow(id);
  if (!imported || !isComfyApiWorkflow(imported.workflow)) {
    const validation = { valid: false, failures: ["Upload the editable reference workflow, generate the ChatGPT workflow request, then import a ComfyUI API workflow."], warnings: ["Preparing a ChatGPT request does not require a ComfyUI connection."] };
    return NextResponse.json({ validation, workflow: null, configuration: getWorkflowConfigurationStatus() }, { status: 422 });
  }
  const validation = await validateImportedApiWorkflow({ workflow: imported.workflow, production: production.data, selectedModels: imported.state.selectedModels, supportingModels: imported.state.supportingModels, reference: reference?.analysis || null });
  return NextResponse.json({ validation, workflow: validation.valid ? imported.workflow : null, configuration: getWorkflowConfigurationStatus() }, { status: validation.valid ? 200 : 422 });
}
