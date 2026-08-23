/**
 * MIME type from filename.
 *
 * The GoPro CDN reports `binary/octet-stream` for everything, so the extension is
 * the only usable signal. Google needs an accurate X-Goog-Upload-Content-Type.
 */

const MAP: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", mkv: "video/x-matroska",
  avi: "video/x-msvideo", webm: "video/webm", mpg: "video/mpeg", mts: "video/mp2t",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic",
  heif: "image/heif", webp: "image/webp", gif: "image/gif", tif: "image/tiff",
  tiff: "image/tiff", dng: "image/x-adobe-dng", avif: "image/avif",
};

export function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MAP[ext] ?? "application/octet-stream";
}

export function isVideo(filename: string): boolean {
  return mimeFor(filename).startsWith("video/");
}
