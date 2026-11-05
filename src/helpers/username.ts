import { getUserByUsername } from "../database/users";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "../constants/limits";
import { Responses } from "../constants/responses";

export const usernameLengthError = (username: string): string | null => {
    const { length } = username.trim();

    if (length < USERNAME_MIN_LENGTH) {
        return Responses.Authentication.usernameTooShort;
    }

    if (length > USERNAME_MAX_LENGTH) {
        return Responses.Authentication.usernameTooLong;
    }

    return null;
};

export const isUsernameTaken = async (username: string, ownerId?: string): Promise<boolean> => {
    const user = await getUserByUsername(username.trim());

    return Boolean(user) && user._id.toString() !== ownerId;
};
