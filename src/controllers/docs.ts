import express from "express";

import { adminSpec, publicSpec } from "../docs/openapi";

const scalarScriptUrl: string =
    "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.77.0/dist/browser/standalone.js";
const scalarScriptIntegrity: string =
    "sha384-+7ESN8b9Ljg46TCYKedZUlhF/wfZbOt78aV/DtoU3anEElh8Q2eXsyhQ9W5lAZD4";
const scalarConfiguration: string = JSON.stringify({
    withDefaultFonts: false,
    telemetry: false,
    showDeveloperTools: "never",
    agent: { disabled: true }
});

const docsPagePolicy: string = [
    "default-src 'none'",
    `script-src ${scalarScriptUrl}`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
].join("; ");

const docsPage = (specUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vb2007.hu API docs</title>
</head>
<body>
<script id="api-reference" data-url="${specUrl}" data-configuration='${scalarConfiguration}'></script>
<script src="${scalarScriptUrl}" integrity="${scalarScriptIntegrity}" crossorigin="anonymous"></script>
</body>
</html>
`;

const sendDocsPage =
    (specUrl: string) =>
    (req: express.Request, res: express.Response): void => {
        res.set("Content-Security-Policy", docsPagePolicy).type("html").send(docsPage(specUrl));
    };

export const getDocsPage = sendDocsPage("/docs/openapi.json");

export const getAdminDocsPage = sendDocsPage("/docs/admin/openapi.json");

export const getPublicSpec = (req: express.Request, res: express.Response): void => {
    res.json(publicSpec);
};

export const getAdminSpec = (req: express.Request, res: express.Response): void => {
    res.json(adminSpec);
};
