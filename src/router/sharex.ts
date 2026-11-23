import express from "express";

import { sendSharexUploader } from "../controllers/sharex";

export default (router: express.Router): void => {
    router.get("/sharex/upload.sxcu", sendSharexUploader("upload"));
    router.get("/sharex/paste.sxcu", sendSharexUploader("paste"));
    router.get("/sharex/shorten.sxcu", sendSharexUploader("shorten"));
};
