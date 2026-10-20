import "multer";

declare module "multer" {
    interface Options {
        defParamCharset?: string;
    }
}
