import express from "express";
import http from "http";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser"
import compression from "compression";
import cors from "cors";
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import router from "./router";

dotenv.config();

const corsOptions = {
    origin: 'http://localhost:5173',
    credentials: true,
};

const app = express();

app.use(cors(corsOptions));

app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json());

const server = http.createServer(app);

const ip = process.env.APP_IP;
const port = process.env.APP_PORT;
server.listen(port, () => {
    console.log(`Server is running on http://${ip}:${port}`);
});

const mongoURL: string = process.env.DB_CONNECTION_STRING;

mongoose.Promise = Promise;
mongoose.connect(mongoURL);
mongoose.connection.on("error", (error: Error) => {
    console.error(error)
});

app.use("/", router());