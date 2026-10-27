import express from "express";

import {
    changeEmail,
    changePassword,
    deleteUser,
    getUser,
    setPassword,
    updateUser
} from "../controllers/users";
import { isAuthenticated, isOwner } from "../middlewares";
import { limitPasswordChecks } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/user", isAuthenticated, getUser);
    router.post("/user/password", isAuthenticated, setPassword);
    router.patch("/user/password", isAuthenticated, limitPasswordChecks, changePassword);
    router.patch("/user/email", isAuthenticated, limitPasswordChecks, changeEmail);
    router.delete("/user", isAuthenticated, deleteUser);
    router.patch("/users/:id", isAuthenticated, isOwner, updateUser);
};
