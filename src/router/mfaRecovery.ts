import express from "express";

import { replaceMfaRecoveryCodes } from "../controllers/mfaRecovery";
import { isAuthenticated } from "../middlewares";
import { limitPasswordChecks } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post(
        "/user/mfa/recovery-codes",
        isAuthenticated,
        limitPasswordChecks,
        replaceMfaRecoveryCodes
    );
};
