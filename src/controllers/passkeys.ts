import express from "express";
import { get, isPlainObject } from "lodash";
import {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

import {
    addPasskey,
    getPasskeys,
    getUserById,
    getUserByPasskey,
    removePasskey,
    renamePasskey,
    usePasskey
} from "../database/users";
import { Passkey } from "../database/passkeys";
import { GITHUB_REAUTH_MINUTES, PASSKEYS_PER_ACCOUNT } from "../constants/limits";
import { Responses } from "../constants/responses";
import { answerRejectedCredential, verifyPassword } from "../helpers/password";
import { isDuplicateKeyError } from "../helpers/mongoose";
import { startSessionIfPresent } from "../helpers/session";
import {
    isCredentialId,
    passkeyAlgorithms,
    passkeyChallengeMs,
    passkeyNameError,
    passkeyOrigin,
    passkeyRpId,
    passkeyTransports,
    storePasskeyChallenge,
    takePasskeyChallenge,
    toPasskeyListItem,
    userHandleOf
} from "../helpers/passkeys";
import { ipKey } from "../middlewares/rateLimit";
import { githubReauthSince, isGithubVerifiedSince } from "./users";

const identityId = (req: express.Request): string => get(req, "identity._id").toString();

const confirmReauth = async (req: express.Request, res: express.Response): Promise<boolean> => {
    const user = await getUserById(identityId(req)).select(
        "+authentication.salt +authentication.password +authentication.githubVerifiedAt"
    );

    if (!user) {
        res.status(403).json({ error: Responses.notLoggedIn });
        return false;
    }

    if (!user.authentication?.password) {
        if (isGithubVerifiedSince(user.authentication?.githubVerifiedAt, githubReauthSince())) {
            return true;
        }

        res.status(403).json({
            error: Responses.Passkeys.githubReauthRequired(GITHUB_REAUTH_MINUTES)
        });
        return false;
    }

    const { password } = req.body;

    if (typeof password !== "string" || !password) {
        res.status(400).json({ error: Responses.Users.missingPassword });
        return false;
    }

    if (
        !(await verifyPassword(
            user.authentication.salt,
            user.authentication.password,
            password,
            ipKey(req.ip)
        ))
    ) {
        answerRejectedCredential(res, Responses.Authentication.incorrectPassword);
        return false;
    }

    return true;
};

export const startPasskeyRegistration = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        if (!(await confirmReauth(req, res))) {
            return;
        }

        const userId: string = identityId(req);
        const user = await getPasskeys(userId);

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const passkeys: Passkey[] = user.authentication?.passkeys ?? [];

        if (passkeys.length >= PASSKEYS_PER_ACCOUNT) {
            return res.status(409).json({ error: Responses.Passkeys.tooManyPasskeys });
        }

        const options = await generateRegistrationOptions({
            rpName: passkeyRpId,
            rpID: passkeyRpId,
            userName: user.username,
            userID: isoBase64URL.toBuffer(userHandleOf(userId)),
            timeout: passkeyChallengeMs,
            attestationType: "none",
            excludeCredentials: passkeys.map(({ credentialId, transports }) => ({
                id: credentialId,
                transports
            })),
            authenticatorSelection: {
                residentKey: "required",
                requireResidentKey: true,
                userVerification: "required"
            },
            supportedAlgorithmIDs: passkeyAlgorithms
        });

        await storePasskeyChallenge(res, options.challenge, userId);

        return res.status(200).json(options);
    } catch (error) {
        return next(error);
    }
};

export const finishPasskeyRegistration = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { name, response } = req.body;

        const nameError: string | null = passkeyNameError(name);
        if (nameError) {
            return res.status(400).json({ error: nameError });
        }

        if (!isPlainObject(response)) {
            return res.status(400).json({ error: Responses.Passkeys.missingResponse });
        }

        const userId: string = identityId(req);
        const challenge: string | null = await takePasskeyChallenge(req, res, userId);

        if (!challenge) {
            return res.status(400).json({ error: Responses.Passkeys.challengeExpired });
        }

        const registration = await verifyRegistrationResponse({
            response: response as RegistrationResponseJSON,
            expectedChallenge: challenge,
            expectedOrigin: passkeyOrigin,
            expectedRPID: passkeyRpId,
            requireUserVerification: true,
            supportedAlgorithmIDs: passkeyAlgorithms
        }).catch((): null => null);

        if (!registration?.verified) {
            return res.status(400).json({ error: Responses.Passkeys.invalidRegistration });
        }

        const { credential } = registration.registrationInfo;
        const passkey: Passkey = {
            credentialId: credential.id,
            publicKey: isoBase64URL.fromBuffer(credential.publicKey),
            counter: credential.counter,
            transports: passkeyTransports(credential.transports),
            name: name.trim(),
            createdAt: new Date()
        };

        const { matchedCount } = await addPasskey(userId, passkey, PASSKEYS_PER_ACCOUNT);

        if (matchedCount === 0) {
            const current = await getPasskeys(userId);

            if (!current) {
                return res.status(403).json({ error: Responses.notLoggedIn });
            }

            return res.status(409).json({
                error: current.authentication?.passkeys?.some(
                    ({ credentialId }) => credentialId === passkey.credentialId
                )
                    ? Responses.Passkeys.alreadyRegistered
                    : Responses.Passkeys.tooManyPasskeys
            });
        }

        return res.status(201).json({
            message: Responses.Passkeys.passkeyAddedSuccess,
            passkey: toPasskeyListItem(passkey)
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Passkeys.alreadyRegistered });
        }

        return next(error);
    }
};

export const listPasskeys = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const user = await getPasskeys(identityId(req));

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res
            .status(200)
            .json({ passkeys: (user.authentication?.passkeys ?? []).map(toPasskeyListItem) });
    } catch (error) {
        return next(error);
    }
};

export const renamePasskeyById = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        const nameError: string | null = passkeyNameError(name);
        if (nameError) {
            return res.status(400).json({ error: nameError });
        }

        const { matchedCount } = isCredentialId(id)
            ? await renamePasskey(identityId(req), id, name.trim())
            : { matchedCount: 0 };

        if (matchedCount === 0) {
            return res.status(404).json({ error: Responses.Passkeys.passkeyNotFound });
        }

        return res.status(200).json({ message: Responses.Passkeys.passkeyRenamedSuccess });
    } catch (error) {
        return next(error);
    }
};

export const deletePasskeyById = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        if (!(await confirmReauth(req, res))) {
            return;
        }

        const { id } = req.params;
        const { matchedCount } = isCredentialId(id)
            ? await removePasskey(identityId(req), id)
            : { matchedCount: 0 };

        if (matchedCount === 0) {
            return res.status(404).json({ error: Responses.Passkeys.passkeyNotFound });
        }

        return res.status(200).json({ message: Responses.Passkeys.passkeyDeletedSuccess });
    } catch (error) {
        return next(error);
    }
};

export const startPasskeyLogin = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const options = await generateAuthenticationOptions({
            rpID: passkeyRpId,
            timeout: passkeyChallengeMs,
            userVerification: "required"
        });

        await storePasskeyChallenge(res, options.challenge, null);

        return res.status(200).json(options);
    } catch (error) {
        return next(error);
    }
};

export const passkeyLogin = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { response } = req.body;

        if (!isPlainObject(response)) {
            return res.status(400).json({ error: Responses.Passkeys.missingResponse });
        }

        const invalidPasskey = () =>
            res.status(403).json({ error: Responses.Passkeys.invalidPasskey });

        const challenge: string | null = await takePasskeyChallenge(req, res, null);
        const credentialId: unknown = response.id;

        if (!challenge || !isCredentialId(credentialId)) {
            return invalidPasskey();
        }

        const user = await getUserByPasskey(credentialId);
        const passkey = user?.authentication?.passkeys?.find(
            (stored) => stored.credentialId === credentialId
        );

        if (!passkey || get(response, "response.userHandle") !== userHandleOf(user.id)) {
            return invalidPasskey();
        }

        const authentication = await verifyAuthenticationResponse({
            response: response as AuthenticationResponseJSON,
            expectedChallenge: challenge,
            expectedOrigin: passkeyOrigin,
            expectedRPID: passkeyRpId,
            credential: {
                id: passkey.credentialId,
                publicKey: isoBase64URL.toBuffer(passkey.publicKey),
                counter: passkey.counter
            },
            requireUserVerification: true
        }).catch((): null => null);

        if (!authentication?.verified) {
            return invalidPasskey();
        }

        if (user.suspendedAt) {
            return res.status(403).json({ error: Responses.Authentication.accountSuspended });
        }

        const { matchedCount } = await usePasskey(
            user._id,
            passkey.credentialId,
            passkey.counter,
            authentication.authenticationInfo.newCounter
        );

        if (matchedCount === 0 || !(await startSessionIfPresent(res, user))) {
            return invalidPasskey();
        }

        return res
            .status(200)
            .json({ message: Responses.Authentication.loginSuccess(user.username) });
    } catch (error) {
        return next(error);
    }
};
