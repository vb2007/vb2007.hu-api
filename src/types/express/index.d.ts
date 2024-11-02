import 'express';

declare module 'express' {
    interface Request {
        identity?: {
            _id: string;
            username: string;
            email: string;
        }
    }
}