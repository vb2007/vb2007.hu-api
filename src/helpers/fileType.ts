import fs from "fs";
import path from "path";

import { ALLOWED_UPLOAD_TYPES, AllowedUploadType } from "../constants/uploads";

const detectedMimeAliases: Record<string, string> = {
    "image/apng": "image/png",
    "audio/x-flac": "audio/flac",
    "audio/x-wav": "audio/wav",
    "audio/x-m4a": "audio/mp4",
    "audio/ogg; codecs=opus": "audio/ogg"
};

const textExtensions: string[] = [".txt", ".md", ".csv", ".json"];

const findByMimeType = (mimeType: string): AllowedUploadType | undefined =>
    ALLOWED_UPLOAD_TYPES.find((type) => type.mimeType === mimeType);

const findByExtension = (extension: string): AllowedUploadType | undefined =>
    ALLOWED_UPLOAD_TYPES.find((type) => type.extension === extension);

const isValidJson = (text: string): boolean => {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
};

const isValidText = (content: Buffer, extension: string): boolean => {
    if (content.includes(0)) {
        return false;
    }

    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
        return false;
    }

    return extension !== ".json" || isValidJson(text);
};

const detectTextType = async (
    filePath: string,
    originalFileName: string
): Promise<AllowedUploadType | undefined> => {
    const extension: string = path.extname(originalFileName).toLowerCase();

    if (!textExtensions.includes(extension)) {
        return undefined;
    }

    const content: Buffer = await fs.promises.readFile(filePath);

    return isValidText(content, extension) ? findByExtension(extension) : undefined;
};

export const detectUploadType = async (
    filePath: string,
    originalFileName: string
): Promise<AllowedUploadType | undefined> => {
    const { fileTypeFromFile } = await import("file-type");
    const detected = await fileTypeFromFile(filePath);

    if (!detected) {
        return detectTextType(filePath, originalFileName);
    }

    return findByMimeType(detectedMimeAliases[detected.mime] ?? detected.mime);
};
