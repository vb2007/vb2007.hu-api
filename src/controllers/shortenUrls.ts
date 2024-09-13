import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";
import { authentication } from "../helpers";

function validateUrl(url: string) {
    if (!url.startsWith("https://") || (!url.startsWith("http://"))) {
        url = "http://" + url;
        return url;
    }
}

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const url = req.body;

        
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
    }
}