import express from "express";

import {
    disableEmailMfa,
    enableEmailMfa,
    getMfaChallenge,
    sendMfaEmail,
    verifyMfa,
    verifyMfaLink
} from "../controllers/mfa";
import { confirmTotpMfa, disableTotpMfa, startTotpSetup } from "../controllers/mfaTotp";
import { isAuthenticated } from "../middlewares";
import {
    limitAccountCodeChecks,
    limitCodeChecks,
    limitMailSends,
    limitPasswordChecks
} from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/auth/mfa", getMfaChallenge);
    router.post("/auth/mfa/verify", limitCodeChecks, verifyMfa);
    router.post("/auth/mfa/verify-link", limitCodeChecks, verifyMfaLink);
    router.post("/auth/mfa/email", limitMailSends, sendMfaEmail);
    router.put("/user/mfa/email", isAuthenticated, limitPasswordChecks, enableEmailMfa);
    router.delete("/user/mfa/email", isAuthenticated, limitPasswordChecks, disableEmailMfa);
    router.post("/user/mfa/totp", isAuthenticated, limitPasswordChecks, startTotpSetup);
    router.post(
        "/user/mfa/totp/confirm",
        isAuthenticated,
        limitPasswordChecks,
        limitAccountCodeChecks,
        confirmTotpMfa
    );
    router.delete("/user/mfa/totp", isAuthenticated, limitPasswordChecks, disableTotpMfa);
};
