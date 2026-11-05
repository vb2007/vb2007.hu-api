import fs from "fs";
import path from "path";

import { deletePastesByUser } from "../database/pastebin";
import { deleteShortUrlsByUser } from "../database/shortUrls";
import { deleteUploadsByUser } from "../database/userUploads";

export const removeUserContent = async (id: string): Promise<void> => {
    await deletePastesByUser(id);
    await deleteShortUrlsByUser(id);
    await deleteUploadsByUser(id);
    await fs.promises.rm(path.join(path.resolve(process.env.UPLOAD_DISK_DIRECTORY), id), {
        recursive: true,
        force: true,
        maxRetries: 3
    });
};
