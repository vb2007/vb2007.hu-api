import express from "express";

import {
    disableEmailMfa,
    enableEmailMfa,
    getMfaChallenge,
    sendMfaEmail,
    verifyMfa,
    verifyMfaLink
} from "../controllers/mfa";
import { isAuthenticated } from "../middlewares";
import { limitCodeChecks, limitMailSends, limitPasswordChecks } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/auth/mfa", getMfaChallenge);
    router.post("/auth/mfa/verify", limitCodeChecks, verifyMfa);
    router.post("/auth/mfa/verify-link", limitCodeChecks, verifyMfaLink);
    router.post("/auth/mfa/email", limitMailSends, sendMfaEmail);
    router.put("/user/mfa/email", isAuthenticated, limitPasswordChecks, enableEmailMfa);
    router.delete("/user/mfa/email", isAuthenticated, limitPasswordChecks, disableEmailMfa);
};
