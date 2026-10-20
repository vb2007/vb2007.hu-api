export type UploadCategory = "image" | "video" | "audio" | "document" | "archive";

export interface AllowedUploadType {
    mimeType: string;
    extension: string;
    category: UploadCategory;
}

export const ALLOWED_UPLOAD_TYPES: AllowedUploadType[] = [
    { mimeType: "image/png", extension: ".png", category: "image" },
    { mimeType: "image/jpeg", extension: ".jpg", category: "image" },
    { mimeType: "image/gif", extension: ".gif", category: "image" },
    { mimeType: "image/webp", extension: ".webp", category: "image" },
    { mimeType: "image/avif", extension: ".avif", category: "image" },
    { mimeType: "video/mp4", extension: ".mp4", category: "video" },
    { mimeType: "video/webm", extension: ".webm", category: "video" },
    { mimeType: "video/quicktime", extension: ".mov", category: "video" },
    { mimeType: "audio/mpeg", extension: ".mp3", category: "audio" },
    { mimeType: "audio/ogg", extension: ".ogg", category: "audio" },
    { mimeType: "audio/wav", extension: ".wav", category: "audio" },
    { mimeType: "audio/flac", extension: ".flac", category: "audio" },
    { mimeType: "audio/mp4", extension: ".m4a", category: "audio" },
    { mimeType: "application/pdf", extension: ".pdf", category: "document" },
    { mimeType: "text/plain", extension: ".txt", category: "document" },
    { mimeType: "text/markdown", extension: ".md", category: "document" },
    { mimeType: "text/csv", extension: ".csv", category: "document" },
    { mimeType: "application/json", extension: ".json", category: "document" },
    { mimeType: "application/zip", extension: ".zip", category: "archive" },
    { mimeType: "application/x-7z-compressed", extension: ".7z", category: "archive" },
    { mimeType: "application/x-tar", extension: ".tar", category: "archive" },
    { mimeType: "application/gzip", extension: ".gz", category: "archive" }
];
