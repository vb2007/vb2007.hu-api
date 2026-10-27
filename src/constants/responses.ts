export class Responses {
    static readonly notLoggedIn: string = "You must be logged in to perform this action.";
    static readonly notAuthorized: string = "You do not have permission to perform this action.";
    static readonly invalidJson: string =
        "The request body must be valid JSON: an object or an array.";
    static readonly internalServerError: string =
        "Something went wrong on the server: please try again later.";
    static readonly tooManyFailedAttempts: string = "Too many failed attempts: try again later.";
    static readonly tooManyEmails: string = "Too many e-mails requested: try again later.";

    static readonly Mongoose = class {
        static readonly invalidIdFormat: string =
            "Invalid ID format: must be a 24 character HEX string.";
        static readonly noSuchObject = (objectType: string): string =>
            `There is no such ${objectType} with that ID in the database.`;
    };

    static readonly Authentication = class {
        //Login
        static readonly missingEmailPassword: string =
            "You must provide an E-mail address and a password.";
        static readonly userNotFound: string = "There is no such user with that E-mail address.";
        static readonly incorrectPassword: string = "The provided password is incorrect.";
        static readonly noPasswordSet: string =
            "This account has no password: log in with GitHub instead.";
        static loginSuccess(username: string): string {
            return `Login successful with user ${username}.`;
        }

        //Logout
        static readonly logoutSuccess: string = "Logged out successfully.";

        //Register
        static readonly missingEmailPasswordUsername: string =
            "You must provide a username, E-mail address, and a password.";
        static readonly emailAlreadyExists: string =
            "An account with this E-mail address already exists.";
        static readonly invalidEmailFormat: string =
            "The e-mail address is invalid: must match name@provider.com format.";
        static readonly usernameTaken: string = "This username is already taken.";
        static readonly usernameTooShort: string =
            "The username's too short: it must be between 2 and 16 characters.";
        static readonly usernameTooLong: string =
            "The username's too long: it must be between 2 and 16 characters.";
        static readonly passwordTooShort: string =
            "The password's too short: it must be between 8 and 128 characters.";
        static readonly passwordTooLong: string =
            "The password's too long: it must be between 8 and 128 characters.";
        static registrationSuccess(username: string): string {
            return `User ${username} registered successfully.`;
        }
        static registrationCodeSent(email: string): string {
            return `A confirmation code was sent to ${email}: send it to POST /auth/register/verify to finish registering.`;
        }
        static readonly registrationCodeResent: string =
            "If a registration is waiting for this address, a new confirmation code was sent to it.";
        static readonly missingEmail: string = "You must provide an E-mail address.";
        static readonly missingEmailCode: string =
            "You must provide an E-mail address and the confirmation code.";
    };

    static readonly EmailCodes = class {
        static readonly invalidCode: string =
            "The code is wrong, expired or already used: check it or request a new one.";
        static readonly mailFailed: string = "The e-mail couldn't be sent: please try again later.";
        static resendTooSoon(seconds: number): string {
            return `A code was sent just now: wait ${seconds} seconds before requesting another one.`;
        }
    };

    static readonly GithubOauth = class {
        //Error codes of the /login or /account ?oauthError= redirect
        static readonly notConfigured: string = "notConfigured";
        static readonly accessDenied: string = "accessDenied";
        static readonly invalidState: string = "invalidState";
        static readonly githubError: string = "githubError";
        static readonly noVerifiedEmail: string = "noVerifiedEmail";
        static readonly emailExists: string = "emailExists";
        static readonly githubAlreadyLinked: string = "githubAlreadyLinked";
        static readonly githubOtherLinked: string = "githubOtherLinked";
        static readonly notLoggedIn: string = "notLoggedIn";

        //Unlink
        static readonly githubNotLinked: string = "No GitHub account is linked to this account.";
        static readonly cannotUnlinkWithoutPassword: string =
            "This account has no password: set one before unlinking GitHub, since it's the only way to log in.";
        static readonly githubUnlinkedSuccess: string = "GitHub account unlinked successfully.";
    };

    static readonly Users = class {
        static readonly missingUsername: string = "You must provide a username.";
        static readonly userUpdatedSuccess: string = "Username updated successfully.";
        static readonly userDeletedSuccess: string = "User deleted successfully.";
        static readonly missingPassword: string = "You must provide a password.";
        static readonly passwordAlreadySet: string = "This account already has a password.";
        static readonly passwordSetSuccess: string = "Password set successfully.";
        static githubReauthRequired(minutes: number): string {
            return `Confirm it's you first: log in with GitHub again (or relink it), then set the password within ${minutes} minutes.`;
        }

        //Change password
        static readonly missingPasswords: string =
            "You must provide the current password and a new password.";
        static readonly noPasswordToChange: string =
            "This account has no password: set one first with POST /user/password.";
        static readonly passwordChangedSuccess: string = "Password changed successfully.";

        //Change e-mail
        static readonly noPasswordToChangeEmail: string =
            "This account has no password: set one before changing the e-mail address.";
        static readonly superuserEmailChange: string =
            "The superuser's e-mail address can't be changed here: change SUPERUSER_EMAIL in .env instead.";
        static readonly emailReservedForSuperuser: string =
            "This e-mail address is reserved for the superuser.";
        static readonly emailUpdatedSuccess: string = "E-mail address updated successfully.";

        //Delete account
        static readonly missingDeletePassword: string =
            "You must provide your password to delete this account.";
        static readonly missingDeleteUsername: string =
            "This account has no password: provide your username to delete it.";
        static readonly incorrectDeleteUsername: string =
            "The provided username doesn't match this account.";
    };

    static readonly ShortenUrl = class {
        //Shorten
        static readonly invalidUrl: string = "The URI/URL you've provided isn't valid.";
        static readonly alreadyShortened: string = "This URL has already been shortened.";
        static readonly urlShortenedSuccess: string = "URL shortened successfully";

        //Redirect & Delete
        static readonly missingShortenedUrl: string = "You must specify a shortened URL.";
        static readonly urlNotFound: string = "The shortened URL cannot be found.";
        static readonly notAuthorizedToDelete: string =
            "You can only delete URLs created with your account.";
        static readonly urlDeletedSuccess: string = "Shortened URL deleted successfully.";
    };

    static readonly Pastebin = class {
        static readonly pasteNotFound: string = "There is no such paste with that ID.";

        //Create
        static readonly pasteCreatedSuccess: string = "Paste created successfully.";
        static readonly missingPaste: string = "You must provide the paste's content.";
        static readonly invalidPasteLength: string =
            "The paste's content must be between 2 and 10000 characters.";
        static readonly invalidLanguage: string =
            "The language is invalid: it must be 1-32 lowercase letters, digits or +#- characters.";

        //Update
        static readonly pasteUpdatedSuccess: string = "Paste updated successfully.";

        //Delete
        static readonly pasteDeletedSuccess: string = "Paste deleted successfully.";

        //Find by username
        static readonly noSuchUser: string = "There is no such user with that username.";
    };

    static readonly UserUploads = class {
        static readonly uploadNotFound: string = "There is no such upload.";
        static readonly uploadSuccess: string = "File uploaded successfully.";
        static readonly uploadDeletedSuccess: string = "Upload deleted successfully.";
        static readonly uploadUpdatedSuccess: string = "Upload updated successfully.";
        static readonly nothingToUpdate: string =
            "Nothing to update: send originalFileName or visibility.";
        static readonly invalidFileName: string =
            "File names must be 1–255 characters, without slashes or control characters.";
        static readonly noFileProvided: string = "No file was provided.";
        static readonly invalidVisibility: string = "Visibility must be public or private.";
        static readonly unsupportedFileType: string = "This file type isn't supported.";
        static readonly quotaExceeded: string = "This upload would go over your storage quota.";
        static fileTooLarge(maxMb: number): string {
            return `The file is larger than the ${maxMb} MB limit.`;
        }
        static invalidQuery(param: string): string {
            return `Invalid value for ${param}.`;
        }
    };

    static readonly Admin = class {
        static readonly userNotFound: string = "There is no such user with that ID.";
        static readonly invalidQuota: string =
            "quotaBytes must be a whole number of bytes from 0, or null for the default quota.";
        static readonly quotaUpdatedSuccess: string = "Upload quota updated successfully.";
        static invalidQuery(param: string): string {
            return `Invalid value for ${param}.`;
        }
    };
}
