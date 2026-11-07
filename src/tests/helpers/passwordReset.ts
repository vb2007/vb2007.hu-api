import { requestPasswordReset } from "../../controllers/authentication";
import { HandlerAnswer, runEmailHandler } from "./emailHandlers";

export const runRequestReset = (email: string): Promise<HandlerAnswer> =>
    runEmailHandler(requestPasswordReset, email);
