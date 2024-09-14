import express  from "express";

import authentication  from "./authentication";
import users from "./users";
import shortenUrls from "./shortenUrls";

const router = express.Router();

export default (): express.Router => {
    authentication(router);
    users(router);
    shortenUrls(router);

    return router;
}