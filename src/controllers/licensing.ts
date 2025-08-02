import express from "express";

import {
    registerApp as registerAppDB,
    assignLicense as assignLicenseDB,
    activateLicense as activateLicenseDB,
    isAppRegistered,
    getUniqueAppIdByUser
} from "../database/licensing";
import { Responses } from "../constants/responses";
import { generateLicenseKey } from "../helpers/text";

export const registerApp = async (req: express.Request, res: express.Response) => {
    try {
        const { uniqueAppId } = req.body;
        const user = req.identity;

        const registerStatus: boolean = await isAppRegistered(uniqueAppId, user._id);
        if (registerStatus) {
            return res.status(409).json({ error: Responses.Licensing.appAlreadyRegistered });
        }

        const response = await registerAppDB({
            uniqueAppId: uniqueAppId,
            userId: user._id
        });

        return res
            .status(201)
            .json({ message: Responses.Licensing.appAlreadyRegistered, data: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const assignLicense = async (req: express.Request, res: express.Response) => {
    try {
        const { userId } = req.body;

        const licenseKey: string = generateLicenseKey(userId);

        const response = await assignLicenseDB(licenseKey, userId);

        return res
            .status(200)
            .json({ message: Responses.Licensing.licenseAssigned, data: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const activateLicense = async (req: express.Request, res: express.Response) => {
    try {
        const { licenseKey } = req.body;
        const user = req.identity;

        if (!licenseKey) {
            return res.status(400).json({ error: Responses.Licensing.noLicenseKeyProvided });
        }

        const uniqueAppId: string = await getUniqueAppIdByUser(user._id);
        const registerStatus: boolean = await isAppRegistered(uniqueAppId, user._id);

        if (!registerStatus) {
            return res.status(404).json({ error: Responses.Licensing.appNotFound });
        }

        const response = await activateLicenseDB(licenseKey, user._id);

        return res
            .status(200)
            .json({ message: Responses.Licensing.licenseActivated, data: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
