import express from "express";

export const shortenedUrlOf = (req: express.Request): unknown =>
    req.params.shortenedUrl ?? req.body.shortenedUrl;
