import crypto from "crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

import { passkeyOrigin, passkeyRpId } from "../../helpers/passkeys";

export const userPresent: number = 0x01;
const userVerified: number = 0x04;
export const attestedCredential: number = 0x40;

const sha256 = (data: Buffer | string): Buffer => crypto.createHash("sha256").update(data).digest();

const uint32 = (value: number): Buffer => {
    const bytes: Buffer = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
};

export interface PasskeyOptions {
    challenge: string;
    user?: { id: string };
}

export interface Ceremony {
    origin?: string;
    rpId?: string;
    flags?: number;
}

export class SoftwareAuthenticator {
    readonly credentialId: string = crypto.randomBytes(16).toString("base64url");
    counter: number = 0;
    userHandle: string | null = null;
    private readonly keys = crypto.generateKeyPairSync("ec", {
        namedCurve: "P-256"
    });

    private cosePublicKey(): Uint8Array {
        const { x, y } = this.keys.publicKey.export({ format: "jwk" });

        return isoCBOR.encode(
            new Map<number, number | Uint8Array>([
                [1, 2],
                [3, -7],
                [-1, 1],
                [-2, Buffer.from(x, "base64url")],
                [-3, Buffer.from(y, "base64url")]
            ])
        );
    }

    private authData(rpId: string, flags: number, attested: boolean): Buffer {
        const credentialId: Buffer = Buffer.from(this.credentialId, "base64url");
        const idLength: Buffer = Buffer.alloc(2);
        idLength.writeUInt16BE(credentialId.length);

        return Buffer.concat([
            sha256(rpId),
            Buffer.from([flags]),
            uint32(this.counter),
            ...(attested
                ? [Buffer.alloc(16), idLength, credentialId, Buffer.from(this.cosePublicKey())]
                : [])
        ]);
    }

    private static clientData(type: string, challenge: string, origin: string): Buffer {
        return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    }

    register(
        options: PasskeyOptions,
        {
            origin = passkeyOrigin,
            rpId = passkeyRpId,
            flags = userPresent | userVerified | attestedCredential
        }: Ceremony = {}
    ) {
        this.userHandle = options.user.id;
        const attestationObject: Uint8Array = isoCBOR.encode(
            new Map<string, string | Uint8Array | Map<number, number>>([
                ["fmt", "none"],
                ["attStmt", new Map<number, number>()],
                ["authData", this.authData(rpId, flags, true)]
            ])
        );

        return {
            id: this.credentialId,
            rawId: this.credentialId,
            type: "public-key",
            response: {
                clientDataJSON: SoftwareAuthenticator.clientData(
                    "webauthn.create",
                    options.challenge,
                    origin
                ).toString("base64url"),
                attestationObject: Buffer.from(attestationObject).toString("base64url"),
                transports: ["internal", "hybrid"]
            },
            clientExtensionResults: {}
        };
    }

    authenticate(
        options: PasskeyOptions,
        {
            origin = passkeyOrigin,
            rpId = passkeyRpId,
            flags = userPresent | userVerified
        }: Ceremony = {}
    ) {
        this.counter++;
        const authData: Buffer = this.authData(rpId, flags, false);
        const clientDataJSON: Buffer = SoftwareAuthenticator.clientData(
            "webauthn.get",
            options.challenge,
            origin
        );
        const signature: Buffer = crypto.sign(
            "sha256",
            Buffer.concat([authData, sha256(clientDataJSON)]),
            this.keys.privateKey
        );

        return {
            id: this.credentialId,
            rawId: this.credentialId,
            type: "public-key",
            response: {
                clientDataJSON: clientDataJSON.toString("base64url"),
                authenticatorData: authData.toString("base64url"),
                signature: signature.toString("base64url"),
                userHandle: this.userHandle
            },
            clientExtensionResults: {}
        };
    }
}
