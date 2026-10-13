export function providerCatalogKey(providerId: string, modelId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(modelId)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const slug = providerId.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return `studio-${slug}-${hash.toString(16).padStart(16, "0")}`;
}
