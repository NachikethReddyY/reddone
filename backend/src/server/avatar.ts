import "server-only";

import sharp from "sharp";

import { AppError } from "./errors";

const avatarDataPattern = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const allowedFormats = new Set(["jpeg", "png", "webp"]);
const maxInputBytes = 500_000;
const maxOutputBytes = 120_000;
const maxInputPixels = 16_777_216;

async function encodeAvatar(input: Buffer, quality: number) {
  return sharp(input, { failOn: "error", limitInputPixels: maxInputPixels })
    .rotate()
    .resize(256, 256, { fit: "cover", position: "attention" })
    .webp({ quality, effort: 4, smartSubsample: true })
    .toBuffer();
}

export async function normalizeAvatarDataUrl(value: string | null): Promise<string | null> {
  if (value === null) return null;
  const match = avatarDataPattern.exec(value);
  if (!match?.[2]) throw new AppError("bad_request", "Upload a JPEG, PNG, or WebP profile image.");

  const input = Buffer.from(match[2], "base64");
  if (input.byteLength < 32 || input.byteLength > maxInputBytes) {
    throw new AppError("bad_request", "The compressed profile image must be smaller than 500 KB.");
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { failOn: "error", limitInputPixels: maxInputPixels }).metadata();
  } catch {
    throw new AppError("bad_request", "The profile image could not be decoded safely.");
  }
  if (!metadata.format || !allowedFormats.has(metadata.format) || (metadata.pages ?? 1) > 1) {
    throw new AppError("bad_request", "Upload a single-frame JPEG, PNG, or WebP profile image.");
  }

  for (const quality of [78, 66, 54]) {
    const output = await encodeAvatar(input, quality);
    if (output.byteLength <= maxOutputBytes) {
      return `data:image/webp;base64,${output.toString("base64")}`;
    }
  }
  throw new AppError("bad_request", "The profile image could not be compressed below 120 KB.");
}
