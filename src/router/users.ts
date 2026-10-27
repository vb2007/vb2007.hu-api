import express from "express";

import { changePassword, deleteUser, getUser, updateUser } from "../controllers/users";
import { isAuthenticated, isOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/user", isAuthenticated, getUser);
    router.patch("/user/password", isAuthenticated, changePassword);
    router.patch("/users/:id", isAuthenticated, isOwner, updateUser);
    router.delete("/users/:id", isAuthenticated, isOwner, deleteUser);
};
