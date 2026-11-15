import { get, isPlainObject } from "lodash";
import { AuthenticationResponseJSON, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

import { hashSessionToken } from ".";
import { passkeyOrigin, passkeyRpId, userHandleOf } from "./passkeys";
import { claimPasskeyChallenge } from "../database/passkeys";
import { usePasskey } from "../database/users";
import { Responses } from "../constants/responses";
import type { MfaMethod, MfaUser } from "./mfa";

export const mfaPasskeyChallengeId = (user: Pick<MfaUser, "authentication">): string =>
    hashSessionToken(`mfaPasskey:${user.authentication.mfaChallenge.hash}`);

export const passkeyMfa: MfaMethod = {
    fields: "+authentication.passkeys",
    storedPaths: [],
    isOn: (authentication) => (authentication?.passkeys?.length ?? 0) > 0,
    isWellFormed: ({ response }) => isPlainObject(response),
    invalidError: Responses.Passkeys.invalidPasskey,
    verify: async (user, { response }) => {
        const userId: string = user._id.toString();
        const stored = await claimPasskeyChallenge(mfaPasskeyChallengeId(user), userId);
        const passkey = user.authentication.passkeys?.find(
            ({ credentialId }) => credentialId === get(response, "id")
        );
        const userHandle: unknown = get(response, "response.userHandle");

        if (!stored || !passkey || (userHandle != null && userHandle !== userHandleOf(userId))) {
            return false;
        }

        const authentication = await verifyAuthenticationResponse({
            response: response as AuthenticationResponseJSON,
            expectedChallenge: stored.challenge,
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
            return false;
        }

        const { matchedCount } = await usePasskey(
            user._id,
            passkey.credentialId,
            passkey.counter,
            authentication.authenticationInfo.newCounter,
            user.authentication.mfaChallenge.hash
        );

        return matchedCount === 1;
    }
};
