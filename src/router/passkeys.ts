import express from "express";

import {
    deletePasskeyById,
    finishPasskeyRegistration,
    listPasskeys,
    passkeyLogin,
    renamePasskeyById,
    startPasskeyLogin,
    startPasskeyRegistration
} from "../controllers/passkeys";
import { isAuthenticated } from "../middlewares";
import {
    limitPasskeyLogins,
    limitPasskeyOptions,
    limitPasswordChecks
} from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post(
        "/user/passkeys/options",
        isAuthenticated,
        limitPasswordChecks,
        startPasskeyRegistration
    );
    router.post("/user/passkeys", isAuthenticated, finishPasskeyRegistration);
    router.get("/user/passkeys", isAuthenticated, listPasskeys);
    router.patch("/user/passkeys/:id", isAuthenticated, renamePasskeyById);
    router.delete("/user/passkeys/:id", isAuthenticated, limitPasswordChecks, deletePasskeyById);
    router.post("/auth/passkey/options", limitPasskeyOptions, startPasskeyLogin);
    router.post("/auth/passkey", limitPasskeyLogins, passkeyLogin);
};
