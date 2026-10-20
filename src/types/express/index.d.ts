import "express";
import { Types } from "mongoose";
import { AllowedUploadType } from "../../constants/uploads";

declare module "express" {
    interface Request {
        identity?: {
            _id: string;
            username: string;
            email: string;
        };
        uploadId?: Types.ObjectId;
        uploadType?: AllowedUploadType;
    }
}
