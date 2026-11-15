import { CreatePage } from "@/components/studio";
export default async function Page({ searchParams }: { searchParams: Promise<{ edit?: string }> }) { const { edit } = await searchParams; return <CreatePage editId={edit}/>; }
