import { SHORT_URL_MAX_LENGTH } from "./limits";

export class Responses {
    static readonly notLoggedIn: string = "You must be logged in to perform this action.";
    static readonly notAuthorized: string = "You do not have permission to perform this action.";
    static readonly invalidJson: string =
        "The request body must be valid JSON: an object or an array.";
    static readonly internalServerError: string =
        "Something went wrong on the server: please try again later.";
    static readonly tooManyFailedAttempts: string = "Too many failed attempts: try again later.";
    static readonly tooManyEmails: string = "Too many e-mails requested: try again later.";
    static readonly tooManyUsernameChecks: string =
        "Too many username checks requested: try again later.";
    static readonly routeNotFound: string = "There is no such route: check the URL and method.";

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
        static readonly invalidCredentials: string =
            "Incorrect e-mail address or password. If you signed up with GitHub, log in with GitHub.";
        static readonly incorrectPassword: string = "The provided password is incorrect.";
        static readonly accountSuspended: string =
            "This account is suspended: it can't log in until the superuser lifts the suspension.";
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
        static readonly disposableEmail: string =
            "Disposable (temporary) e-mail addresses can't be used: use a permanent one.";
        static readonly undeliverableEmailDomain: string =
            "This e-mail address's domain can't receive e-mail: check it for typos.";
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
        static readonly missingEmailCodeUsernamePassword: string =
            "You must provide an E-mail address, the confirmation code, a username and a password.";

        //Password reset
        static readonly passwordResetSent: string =
            "If an account uses this address, a password reset code was sent to it in the last minute or just now: use the latest one.";
        static readonly missingPasswordResetFields: string =
            "You must provide the E-mail address, the code and a new password.";
        static readonly passwordResetSuccess: string =
            "Password reset successfully: log in with the new password.";
        static readonly missingPasswordResetLinkFields: string =
            "You must provide the reset link's token and a new password.";
        static readonly invalidPasswordResetLink: string =
            "The reset link is wrong, expired or already used: request a new one.";
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
        static readonly passwordRequired: string = "passwordRequired";
        static readonly accountSuspended: string = "accountSuspended";

        //Link & Unlink
        static readonly missingPassword: string =
            "You must provide your password to link or unlink GitHub.";

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
        static emailChangeCodeSent(email: string): string {
            return `A confirmation code was sent to ${email}: send it to POST /user/email/confirm to switch to that address.`;
        }
        static readonly missingCode: string = "You must provide the confirmation code.";

        //Delete account
        static readonly missingDeletePassword: string =
            "You must provide your password to delete this account.";
        static readonly missingDeleteUsername: string =
            "This account has no password: provide your username to delete it.";
        static readonly incorrectDeleteUsername: string =
            "The provided username doesn't match this account.";
        static githubReauthRequiredToDelete(minutes: number): string {
            return `Confirm it's you first: log in with GitHub again (or relink it), then delete the account within ${minutes} minutes.`;
        }
    };

    static readonly ShortenUrl = class {
        //Shorten
        static readonly invalidUrl: string = "The URI/URL you've provided isn't valid.";
        static readonly urlTooLong: string = `The URI/URL can be at most ${SHORT_URL_MAX_LENGTH} characters long.`;
        static readonly alreadyShortened: string = "You've already shortened this URL.";
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
        static invalidQuery(param: string): string {
            return `Invalid value for ${param}.`;
        }
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
        static readonly invalidSuspension: string = "suspended must be true or false.";
        static readonly superuserSuspension: string = "The superuser's account can't be suspended.";
        static readonly userSuspendedSuccess: string =
            "User suspended successfully: their session was ended.";
        static readonly userUnsuspendedSuccess: string = "User unsuspended successfully.";
        static readonly userRenamedSuccess: string = "Username updated successfully.";
        static invalidQuery(param: string): string {
            return `Invalid value for ${param}.`;
        }
        static readonly cannotDeleteSuperuser: string =
            "The superuser's own account can't be deleted.";
        static readonly userDeletedSuccess: string = "User deleted successfully.";
    };
}
