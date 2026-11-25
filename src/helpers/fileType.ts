import fs from "fs";
import path from "path";
import { isUtf8 } from "buffer";

import { ALLOWED_UPLOAD_TYPES, AllowedUploadType } from "../constants/uploads";
import { UPLOAD_JSON_VALIDATION_MAX_BYTES } from "../constants/limits";

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

const isValidJson = (content: Buffer): boolean => {
    try {
        JSON.parse(new TextDecoder().decode(content));
        return true;
    } catch {
        return false;
    }
};

const isValidText = (content: Buffer, extension: string): boolean =>
    !content.includes(0) && isUtf8(content) && (extension !== ".json" || isValidJson(content));

const isOverJsonValidationLimit = async (filePath: string, extension: string): Promise<boolean> =>
    extension === ".json" &&
    (await fs.promises.stat(filePath)).size > UPLOAD_JSON_VALIDATION_MAX_BYTES;

const detectTextType = async (
    filePath: string,
    originalFileName: string
): Promise<AllowedUploadType | undefined> => {
    const extension: string = path.extname(originalFileName).toLowerCase();

    if (
        !textExtensions.includes(extension) ||
        (await isOverJsonValidationLimit(filePath, extension))
    ) {
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
