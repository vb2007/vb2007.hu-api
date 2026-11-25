import express from "express";
import http from "http";
import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import router from "./router";
import {
    handleRequestError,
    ignoreRequestsAfterEarlyAnswer,
    ignoreRequestsFromGoneClients,
    parseJsonBody,
    refuseForeignOrigins
} from "./middlewares";
import { Responses } from "./constants/responses";
import { parseCorsOrigins } from "./helpers/cors";
import { checkCryptoSecretKey } from "./helpers/cryptoKey";
import { responseEnded, trackPendingWork } from "./helpers/pendingWork";
import { closeWhenBodyUnread, continueWhenBodyRead } from "./helpers/requestBody";
import { shutDownOnSignals } from "./helpers/shutdown";
import { schedulePartialUploadRemoval } from "./helpers/partialUploads";
import { isDatabaseReachable } from "./helpers/prisma";

dotenv.config();

if (checkCryptoSecretKey(process.env.CRYPTO_SECRET_KEY).length < 32) {
    console.warn(
        "CRYPTO_SECRET_KEY is shorter than 32 characters, but changing it breaks every stored password and API key hash: see docs/dotenv-setup.md"
    );
}

const corsOriginUrls: string[] = parseCorsOrigins(process.env.CORS_ORIGIN_URLS);
const corsOptions = {
    origin: corsOriginUrls,
    credentials: true,
    exposedHeaders: ["Retry-After", "WWW-Authenticate"]
};

const app: express.Express = express();

app.set("trust proxy", "loopback, uniquelocal");

app.use(ignoreRequestsFromGoneClients);
app.use(ignoreRequestsAfterEarlyAnswer);
app.use(closeWhenBodyUnread);

app.use((req: express.Request, res: express.Response, next: express.NextFunction): void => {
    trackPendingWork(responseEnded(res));
    next();
});

app.use(cors(corsOptions));
app.use(refuseForeignOrigins(corsOriginUrls));

app.use(compression());
app.use(cookieParser());
app.use(parseJsonBody);

const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";
app.get("/", (req: express.Request, res: express.Response): void => {
    res.status(302).redirect(baseSiteUrl);
});

app.get("/healthz", async (req: express.Request, res: express.Response): Promise<void> => {
    res.sendStatus((await isDatabaseReachable()) ? 200 : 503);
});

const server: http.Server = http.createServer(app);
server.on("checkContinue", continueWhenBodyRead(server));

const ip: string = process.env.APP_IP;
const port: number = Number(process.env.APP_PORT);
server.listen(port, ip, (): void => {
    console.log(`Server is running on http://${ip}:${port}`);
});

schedulePartialUploadRemoval();

app.use("/", router());

app.use((req: express.Request, res: express.Response): void => {
    if (req.accepts(["json", "html"]) === "html") {
        res.redirect(302, `${baseSiteUrl}/apierror?url=${encodeURIComponent(req.path)}`);
        return;
    }

    res.vary("Accept");
    res.status(404).json({ error: Responses.routeNotFound });
});

app.use(handleRequestError);

shutDownOnSignals(server);
