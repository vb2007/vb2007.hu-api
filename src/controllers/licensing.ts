import express from "express";
import { get } from "lodash";

import {
    registerApp as registerAppDB,
    assignLicense as assignLicenseDB,
    activateLicense as activateLicenseDB,
    isAppRegistered,
    getUniqueAppIdByUser
} from "../database/licensing";
import { generateLicenseKey } from "../helpers/text";
import { Responses } from "../constants/responses";

export const registerApp = async (req: express.Request, res: express.Response) => {
    try {
        const { uniqueAppId } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        const registerStatus: boolean = await isAppRegistered(uniqueAppId, currentUserId);
        if (registerStatus) {
            return res.status(409).json({ error: Responses.Licensing.appAlreadyRegistered });
        }

        const response = await registerAppDB({
            uniqueAppId: uniqueAppId,
            userId: currentUserId
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
        const userId = req.path;

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
        const currentUserId = get(req, "identity._id") as string;

        if (!licenseKey) {
            return res.status(400).json({ error: Responses.Licensing.noLicenseKeyProvided });
        }

        const uniqueAppId: string = await getUniqueAppIdByUser(currentUserId);
        const registerStatus: boolean = await isAppRegistered(uniqueAppId, currentUserId);

        if (!registerStatus) {
            return res.status(404).json({ error: Responses.Licensing.appNotFound });
        }

        const response = await activateLicenseDB(licenseKey, currentUserId);

        return res
            .status(200)
            .json({ message: Responses.Licensing.licenseActivated, data: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
