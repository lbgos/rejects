export const jpegSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === 0xc0 || marker === 0xc2)
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
};

export const jpegSizeOfBase64 = (data: string) =>
  jpegSize(Buffer.from(data.slice(0, 8192 - (8192 % 4)), "base64"));
