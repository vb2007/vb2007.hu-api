import mongoose from "mongoose";

export interface Passkey {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    name: string;
    createdAt: Date;
    lastUsedAt?: Date | null;
}

export const PasskeySchema = new mongoose.Schema(
    {
        credentialId: { type: String, required: true },
        publicKey: { type: String, required: true },
        counter: { type: Number, required: true },
        transports: { type: [String], default: undefined },
        name: { type: String, required: true },
        createdAt: { type: Date, required: true },
        lastUsedAt: { type: Date, default: null }
    },
    { _id: false }
);

const PasskeyChallengeSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    challenge: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true, expires: 0 }
});

export const PasskeyChallengeModel = mongoose.model("PasskeyChallenge", PasskeyChallengeSchema);

export const savePasskeyChallenge = (
    idHash: string,
    challenge: string,
    userId: string | null,
    expiresAt: Date
) => PasskeyChallengeModel.create({ _id: idHash, challenge, userId, expiresAt });

export const claimPasskeyChallenge = (idHash: string, userId: string | null) =>
    PasskeyChallengeModel.findOneAndDelete({
        _id: { $eq: idHash },
        userId: { $eq: userId },
        expiresAt: { $gt: new Date() }
    }).lean();
