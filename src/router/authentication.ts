import express from "express";

import {
    confirmPasswordReset,
    githubCallback,
    githubLink,
    githubLogin,
    githubUnlink,
    login,
    logout,
    register,
    requestPasswordReset,
    resendRegistrationCode,
    verifyRegistration
} from "../controllers/authentication";
import { isAuthenticated } from "../middlewares";
import { limitCodeChecks, limitLoginAttempts, limitMailSends } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post("/auth/register", limitMailSends, register);
    router.post("/auth/register/resend", limitMailSends, resendRegistrationCode);
    router.post("/auth/register/verify", limitCodeChecks, verifyRegistration);
    router.post("/auth/login", limitLoginAttempts, login);
    router.post("/auth/password-reset", limitMailSends, requestPasswordReset);
    router.post("/auth/password-reset/confirm", limitCodeChecks, confirmPasswordReset);
    router.post("/auth/logout", logout);
    router.get("/auth/github", githubLogin);
    router.get("/auth/github/link", githubLink);
    router.delete("/auth/github/link", isAuthenticated, githubUnlink);
    router.get("/auth/github/callback", githubCallback);
};
