import express  from "express";

import authentication  from "./authentication";
import users from "./users";
import shortenUrls from "./shortenUrls";
import pastebin from "./pastebin";

const router = express.Router();

export default (): express.Router => {
    authentication(router);
    users(router);
    shortenUrls(router);
    pastebin(router);

    return router;
}