import mongoose from "mongoose";

const LicensingSchema = new mongoose.Schema({
    licenseKey: {
        type: String,
        required: false,
        unique: true,
        default: null
    },
    uniqueAppId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },
    usage: {
        isUsed: {
            type: Boolean,
            default: false
        },
        createdAt: {
            type: Date,
            default: null
        },
        usedAt: {
            type: Date,
            default: null
        }
    }
});

export const LicensingModel = mongoose.model("Licensing", LicensingSchema);

export const getLicenseByUserId = (userId: string) =>
    LicensingModel.findOne({ userId }).then((licensing) => licensing?.toObject());
export const getAllLicenses = () =>
    LicensingModel.find().then((licenses) => licenses.map((license) => license.toObject()));
export const registerApp = (values: Record<string, any>) =>
    new LicensingModel(values).save().then((licensing) => licensing.toObject());
export const getUniqueAppIdByUser = (userId: string) =>
    LicensingModel.findOne({ userId }).then((licensing) => licensing?.uniqueAppId);
export const isAppRegistered = (uniqueAppId: string, userId: string) =>
    LicensingModel.findOne({ uniqueAppId, userId }).then((licensing) => !!licensing);
export const assignLicense = (licenseKey: string, userId: string) =>
    LicensingModel.findOneAndUpdate(
        { userId: userId },
        {
            licenseKey: licenseKey,
            "usage.createdAt": new Date()
        },
        { new: true }
    ).then((licensing) => licensing?.toObject());
export const activateLicense = (licenseKey: string, userId: string) =>
    LicensingModel.findOneAndUpdate(
        { userId: userId },
        {
            licenseKey: licenseKey,
            "usage.isUsed": true,
            "usage.usedAt": new Date()
        },
        { new: true }
    ).then((licensing) => licensing?.toObject());
