import express from "express";
import http from "http";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser"
import compression from "compression";
import cors from "cors";

const app = express();

app.use(cors({
    credentials: true,
}));

app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json());

const server = http.createServer(app);

const ip = "localhost";
const port = 3000;
server.listen(port, () => {
    console.log(`Server is running on http://${ip}:${port}`);
});