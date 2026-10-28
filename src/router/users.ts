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
import { isAuthenticated, isOwner } from "../middlewares";
import {
    limitAccountCodeChecks,
    limitMailSends,
    limitPasswordChecks
} from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/user", isAuthenticated, getUser);
    router.post("/user/password", isAuthenticated, setPassword);
    router.patch("/user/password", isAuthenticated, limitPasswordChecks, changePassword);
    router.patch("/user/email", isAuthenticated, limitPasswordChecks, limitMailSends, changeEmail);
    router.post("/user/email/confirm", isAuthenticated, limitAccountCodeChecks, confirmEmailChange);
    router.delete("/user", isAuthenticated, limitPasswordChecks, deleteUser);
    router.patch("/users/:id", isAuthenticated, isOwner, updateUser);
};
