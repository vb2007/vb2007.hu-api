import { getUserByUsername } from "../database/users";
import { Responses } from "../constants/responses";

export const usernameLengthError = (username: string): string | null => {
    const { length } = username.trim();

    if (length < 2) {
        return Responses.Authentication.usernameTooShort;
    }

    if (length > 16) {
        return Responses.Authentication.usernameTooLong;
    }

    return null;
};

export const isUsernameTaken = async (username: string, ownerId?: string): Promise<boolean> => {
    const user = await getUserByUsername(username.trim());

    return Boolean(user) && user._id.toString() !== ownerId;
};
