import express from "express";

import { deleteUser, getUser, setPassword, updateUser } from "../controllers/users";
import { isAuthenticated, isOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/user", isAuthenticated, getUser);
    router.post("/user/password", isAuthenticated, setPassword);
    router.patch("/users/:id", isAuthenticated, isOwner, updateUser);
    router.delete("/users/:id", isAuthenticated, isOwner, deleteUser);
};
