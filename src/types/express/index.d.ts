import "express";
import { Types } from "mongoose";

declare module "express" {
    interface Request {
        identity?: {
            _id: string;
            username: string;
            email: string;
        };
        uploadId?: Types.ObjectId;
    }
}
