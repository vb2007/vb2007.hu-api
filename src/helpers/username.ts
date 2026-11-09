import { getUserByUsername } from "../database/users";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "../constants/limits";
import { Responses } from "../constants/responses";

const usernameCollator: Intl.Collator = new Intl.Collator("en", { sensitivity: "accent" });
const emojiPresentationSelectors: RegExp = /(?<=\p{Emoji})[\ufe0e\ufe0f]/gu;
const invalidUsernameCharacter: RegExp = /[^\S ]|[\p{C}\p{Default_Ignorable_Code_Point}\u2800]/u;
const combiningMarks: RegExp = /\p{M}/gu;

const isIgnoredByCollation = (character: string): boolean =>
    usernameCollator.compare(character, "") === 0;

const hasInvalidCharacter = (username: string): boolean => {
    const checked: string = username.replace(emojiPresentationSelectors, "");

    return invalidUsernameCharacter.test(checked) || [...checked].some(isIgnoredByCollation);
};

export const usernameFormatError = (username: string): string | null => {
    const trimmed: string = username.trim();

    if (trimmed.length > USERNAME_MAX_LENGTH) {
        return Responses.Authentication.usernameTooLong;
    }

    if (hasInvalidCharacter(trimmed)) {
        return Responses.Authentication.usernameInvalidCharacters;
    }

    if ([...trimmed.replace(combiningMarks, "")].length < USERNAME_MIN_LENGTH) {
        return Responses.Authentication.usernameTooShort;
    }

    return null;
};

export const isUsernameTaken = async (username: string, ownerId?: string): Promise<boolean> => {
    const user = await getUserByUsername(username.trim());

    return Boolean(user) && !user._id.equals(ownerId);
};
