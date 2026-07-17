export async function pingHealthcheck(url: string | undefined, success: boolean): Promise<void> {
  if (!url) return;
  const target = success ? url : `${url}/fail`;
  try {
    await fetch(target, { method: "GET" });
  } catch {
    return;
  }
}
