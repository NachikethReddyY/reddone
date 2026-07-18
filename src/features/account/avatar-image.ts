const allowedAvatarTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxOriginalBytes = 10 * 1024 * 1024;
const maxClientBytes = 500_000;
const canvasSize = 512;

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

async function decodeWithImageElement(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("The selected image could not be decoded.");
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap !== "function") return decodeWithImageElement(file);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    return decodeWithImageElement(file);
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not compress this image."));
    }, "image/webp", quality);
  });
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The compressed image could not be read."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The compressed image could not be read."));
    reader.readAsDataURL(blob);
  });
}

export async function compressAvatarFile(file: File) {
  if (!allowedAvatarTypes.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > maxOriginalBytes) throw new Error("Choose an image smaller than 10 MB.");

  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("The selected image has invalid dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not prepare this image.");

    const scale = Math.max(canvasSize / decoded.width, canvasSize / decoded.height);
    const width = decoded.width * scale;
    const height = decoded.height * scale;
    context.drawImage(decoded.source, (canvasSize - width) / 2, (canvasSize - height) / 2, width, height);

    let output = await canvasBlob(canvas, 0.82);
    if (output.size > maxClientBytes) output = await canvasBlob(canvas, 0.64);
    if (output.size > maxClientBytes) throw new Error("Choose an image with less visual detail so it can be compressed safely.");
    return dataUrl(output);
  } finally {
    decoded.release();
  }
}
