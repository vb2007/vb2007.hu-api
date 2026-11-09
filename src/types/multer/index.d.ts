import "multer";
import express from "express";
import { Writable } from "stream";

declare module "multer" {
    interface Options {
        defParamCharset?: string;
        streamHandler?: (req: express.Request, busboy: Writable) => void;
    }
}
