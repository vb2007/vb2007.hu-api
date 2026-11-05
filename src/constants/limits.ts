export const SHORT_URL_MAX_LENGTH: number = 2000;
export const SHORT_URL_CODE_LENGTH: number = 6;
export const SHORT_URL_CODE_ATTEMPTS: number = 5;

export const USERNAME_MIN_LENGTH: number = 2;
export const USERNAME_MAX_LENGTH: number = 16;
export const PASSWORD_MIN_LENGTH: number = 8;
export const PASSWORD_MAX_LENGTH: number = 128;
export const EMAIL_MAX_LENGTH: number = 254;
export const EMAIL_LOCAL_PART_MAX_LENGTH: number = 64;

export const PASTE_MIN_LENGTH: number = 2;
export const PASTE_MAX_LENGTH: number = 10000;
export const PASTE_LANGUAGE_MIN_LENGTH: number = 1;
export const PASTE_LANGUAGE_MAX_LENGTH: number = 32;
export const PASTE_PREVIEW_LENGTH: number = 100;

export const SESSION_MAX_AGE_MS: number = 1000 * 60 * 60 * 24 * 7;
export const DEVICE_COOKIE_MAX_AGE_MS: number = 1000 * 60 * 60 * 24 * 30;

export const LIST_MAX_LIMIT: number = 50;
export const LIST_QUERY_MAX_LENGTH: number = 100;

export const UPLOAD_FILE_NAME_MIN_LENGTH: number = 1;
export const UPLOAD_FILE_NAME_MAX_LENGTH: number = 255;
export const UPLOAD_URL_TTL_SECONDS: number = 60 * 60;

export const FAILED_ATTEMPTS_WINDOW_MS: number = 15 * 60 * 1000;
export const FAILED_ATTEMPTS_PER_ACCOUNT: number = 10;
export const FAILED_ATTEMPTS_PER_IP: number = 100;
export const FAILED_LOGINS_PER_EMAIL: number = 100;
export const IP_SUBNET: number = 56;
export const EMAIL_AND_IP_SUBNET: number = 48;
export const MAIL_SENDS_WINDOW_MS: number = 60 * 60 * 1000;
export const MAIL_SENDS_PER_IP: number = 10;
export const USERNAME_CHECKS_WINDOW_MS: number = 60 * 1000;
export const USERNAME_CHECKS_PER_IP: number = 30;

export const REGISTRATION_CODE_MINUTES: number = 15;
export const PENDING_REGISTRATION_HOURS: number = 24;
export const EMAIL_CHANGE_CODE_MINUTES: number = 15;
export const PASSWORD_RESET_CODE_MINUTES: number = 30;
export const GITHUB_OAUTH_MINUTES: number = 10;
export const GITHUB_REAUTH_MINUTES: number = 10;
export const GITHUB_SIGN_UP_ATTEMPTS: number = 3;

export const EMAIL_CODE_LENGTH: number = 6;
export const EMAIL_CODE_MAX_ATTEMPTS: number = 5;
export const EMAIL_CODE_RESEND_SECONDS: number = 60;
export const CODE_FAILURES_WINDOW_MS: number = 24 * 60 * 60 * 1000;
export const CODE_FAILURES_PER_DAY: number = 20;
