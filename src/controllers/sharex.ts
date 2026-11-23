import express from "express";

import { Responses } from "../constants/responses";
import { SharexUploaderName, isPlainHost, sharexUploaders } from "../helpers/sharex";

export const sendSharexUploader =
    (name: SharexUploaderName): express.RequestHandler =>
    (req: express.Request, res: express.Response): express.Response => {
        const host: string | undefined = req.get("host");

        if (!isPlainHost(host)) {
            return res.status(400).json({ error: Responses.Sharex.invalidHost });
        }

        return res
            .set({
                "Cache-Control": "private, no-store",
                "Content-Disposition": `attachment; filename="vb2007-${name}.sxcu"`
            })
            .json(sharexUploaders(`${req.protocol}://${host}`)[name]);
    };
