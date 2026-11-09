import express from "express";
import http from "http";
import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import router from "./router";
import {
    handleRequestError,
    ignoreRequestsAfterTooLarge,
    ignoreRequestsFromGoneClients,
    parseJsonBody
} from "./middlewares";
import { Responses } from "./constants/responses";
import { parseCorsOrigins } from "./helpers/cors";
import { responseEnded, trackPendingWork } from "./helpers/pendingWork";
import { shutDownOnSignals } from "./helpers/shutdown";
import { schedulePartialUploadRemoval } from "./helpers/partialUploads";

dotenv.config();

const corsOriginUrls: string[] = parseCorsOrigins(process.env.CORS_ORIGIN_URLS);
const corsOptions = {
    origin: corsOriginUrls,
    credentials: true,
    exposedHeaders: ["Retry-After"]
};

const app: express.Express = express();

app.set("trust proxy", "loopback, uniquelocal");

app.use(ignoreRequestsAfterTooLarge);
app.use(ignoreRequestsFromGoneClients);

app.use((req: express.Request, res: express.Response, next: express.NextFunction): void => {
    trackPendingWork(responseEnded(res));
    next();
});

app.use(cors(corsOptions));

app.use(compression());
app.use(cookieParser());
app.use(parseJsonBody);

const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";
app.get("/", (req: express.Request, res: express.Response): void => {
    res.status(302).redirect(baseSiteUrl);
});

app.get("/healthz", (req: express.Request, res: express.Response): void => {
    const isDatabaseConnected: boolean =
        mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    res.sendStatus(isDatabaseConnected ? 200 : 503);
});

const server: http.Server = http.createServer(app);

const ip: string = process.env.APP_IP;
const port: number = Number(process.env.APP_PORT);
server.listen(port, ip, (): void => {
    console.log(`Server is running on http://${ip}:${port}`);
});

const mongoURL: string = process.env.DB_CONNECTION_STRING;

mongoose.Promise = Promise;
mongoose.connect(mongoURL);
schedulePartialUploadRemoval();
mongoose.connection.on("error", (error: Error): void => {
    console.error(`Connection to MongoDB failed:\n${error}`);
});

app.use("/", router());

app.use((req: express.Request, res: express.Response): void => {
    if (req.accepts(["json", "html"]) === "html") {
        const notFoundPath: string = req.originalUrl;
        res.redirect(302, `${baseSiteUrl}/apierror?url=${encodeURIComponent(notFoundPath)}`);
        return;
    }

    res.vary("Accept");
    res.status(404).json({ error: Responses.routeNotFound });
});

app.use(handleRequestError);

shutDownOnSignals(server);
