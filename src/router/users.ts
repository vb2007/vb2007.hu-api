import express from "express";

import {
    changeEmail,
    changePassword,
    confirmEmailChange,
    deleteUser,
    getUser,
    setPassword,
    updateUser
} from "../controllers/users";
import { isAuthenticated, isAuthenticatedWith, isOwner } from "../middlewares";
import {
    limitAccountCodeChecks,
    limitMailSends,
    limitPasswordChecks
} from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/user", isAuthenticatedWith("account:read"), getUser);
    router.post("/user/password", isAuthenticated, setPassword);
    router.patch("/user/password", isAuthenticated, limitPasswordChecks, changePassword);
    router.patch("/user/email", isAuthenticated, limitPasswordChecks, limitMailSends, changeEmail);
    router.post("/user/email/confirm", isAuthenticated, limitAccountCodeChecks, confirmEmailChange);
    router.delete("/user", isAuthenticated, limitPasswordChecks, deleteUser);
    router.patch("/users/:id", isAuthenticatedWith("account:write"), isOwner, updateUser);
};
