export async function pingHealthcheck(url: string, success: boolean): Promise<void> {
  const target = success ? url : `${url}/fail`;
  try {
    await fetch(target, { method: "GET" });
  } catch {
    return;
  }
}
