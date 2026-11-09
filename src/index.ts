import express from "express";
import http from "http";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import router from "./router";
import { handleRequestError } from "./middlewares";
import { Responses } from "./constants/responses";
import { parseCorsOrigins } from "./helpers/cors";
import { pendingWorkSettled, responseEnded, trackPendingWork } from "./helpers/pendingWork";

dotenv.config();

const corsOriginUrls: string[] = parseCorsOrigins(process.env.CORS_ORIGIN_URLS);
const corsOptions = {
    origin: corsOriginUrls,
    credentials: true,
    exposedHeaders: ["Retry-After"]
};

const app: express.Express = express();

app.set("trust proxy", "loopback, uniquelocal");

app.use((req: express.Request, res: express.Response, next: express.NextFunction): void => {
    trackPendingWork(responseEnded(res));
    next();
});

app.use(cors(corsOptions));

app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json());

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

const shutdownDeadlineMs: number = 8 * 1000;
let isShuttingDown: boolean = false;

const closeServer = (): Promise<void> =>
    new Promise((resolve): void => {
        server.close((): void => resolve());
    });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
        console.error(`${signal} received again, exiting now`);
        process.exit(1);
    }
    isShuttingDown = true;
    console.log(`${signal} received, shutting down`);

    setTimeout((): void => {
        console.error(`Shutdown took over ${shutdownDeadlineMs / 1000} s, exiting anyway`);
        process.exit(1);
    }, shutdownDeadlineMs);

    try {
        await closeServer();
        await pendingWorkSettled();
        await mongoose.disconnect();
        console.log("Shutdown complete");
        process.exit(0);
    } catch (error) {
        console.error("Shutdown failed:", error);
        process.exit(1);
    }
};

server.on("request", (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.on("finish", (): void => {
        if (isShuttingDown) {
            server.closeIdleConnections();
        }
    });
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
