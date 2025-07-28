export class Responses {
    static readonly notLoggedIn: string = "You must be logged in to perform this action.";
    static readonly notAuthorized: string = "You do not have permission to perform this action.";

    static readonly Mongoose = class {
        static readonly invalidIdFormat: string =
            "Invalid ID format: must be a 24 character HEX string.";
        static readonly noSuchObject: (objectType: string) => string = (objectType: string) =>
            `There is no such ${objectType} with that ID in the database.`;
    };

    static readonly Authentication = class {
        //Login
        static readonly missingEmailPassword: string =
            "You must provide an E-mail address and a password.";
        static readonly userNotFound: string = "There is no such user with that E-mail address.";
        static readonly incorrectPassword: string = "The provided password is incorrect.";
        static loginSuccess(username: string): string {
            return `Login successful with user ${username}.`;
        }

        //Register
        static readonly missingEmailPasswordUsername: string =
            "You must provide a username, E-mail address, and a password.";
        static readonly emailAlreadyExists: string =
            "An account with this E-mail address already exists.";
        static readonly usernameTaken: string = "This username is already taken.";
        static registrationSuccess(username: string): string {
            return `User ${username} registered successfully.`;
        }
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
        static readonly noSuchUser: string = "There is no such user with that username.";
    };
}
