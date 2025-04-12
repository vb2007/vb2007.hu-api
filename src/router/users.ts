import express from "express";

import { deleteUser, getAllUsers, getUser, updateUser } from "../controllers/users";
import { isAuthenticated, isOwner } from "../middlewares";

export default (router: express.Router) => {
    router.get("/user", isAuthenticated, getUser);
    router.get("/users", isAuthenticated, getAllUsers);
    router.patch("/users/:id", isAuthenticated, isOwner, updateUser)
    router.delete("/users/:id", isAuthenticated, isOwner, deleteUser);
}