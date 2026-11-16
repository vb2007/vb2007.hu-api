import "express";
import { AllowedUploadType } from "../../constants/uploads";

declare module "express" {
    interface Request {
        identity?: {
            _id: string;
            username: string;
            email: string;
        };
        uploadId?: string;
        uploadType?: AllowedUploadType;
    }
}
