import { getUserByUsername } from "../database/users";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "../constants/limits";
import { Responses } from "../constants/responses";

const invalidUsernameCharacter: RegExp =
    /[^\S ]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export const usernameFormatError = (username: string): string | null => {
    const trimmed: string = username.trim();

    if (invalidUsernameCharacter.test(trimmed)) {
        return Responses.Authentication.usernameInvalidCharacters;
    }

    if (trimmed.length < USERNAME_MIN_LENGTH) {
        return Responses.Authentication.usernameTooShort;
    }

    if (trimmed.length > USERNAME_MAX_LENGTH) {
        return Responses.Authentication.usernameTooLong;
    }

    return null;
};

export const isUsernameTaken = async (username: string, ownerId?: string): Promise<boolean> => {
    const user = await getUserByUsername(username.trim());

    return Boolean(user) && user._id.toString() !== ownerId;
};
